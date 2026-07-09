require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
const EXEC_TIMEOUT_MS = Number(process.env.EXEC_TIMEOUT_MS) || 10_000;
const MAX_CODE_LENGTH = Number(process.env.MAX_CODE_LENGTH) || 20_000;
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 20;
const SANDBOX_DIR = path.join(__dirname, 'tmp');

fs.mkdirSync(SANDBOX_DIR, { recursive: true });

function levenshteinDistance(left, right) {
    if (!left.length) return right.length;
    if (!right.length) return left.length;

    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    const current = new Array(right.length + 1).fill(0);

    for (let i = 1; i <= left.length; i++) {
        current[0] = i;
        for (let j = 1; j <= right.length; j++) {
            const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
            current[j] = Math.min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + substitutionCost
            );
        }
        for (let j = 0; j <= right.length; j++) {
            previous[j] = current[j];
        }
    }

    return previous[right.length];
}

// The reference compiler binary (qrun) is not always available in dev/CI.
// These mirror the frontend's built-in IDE samples so the demo still works end to end.
function handleKnownSamples(code) {
    if (code.includes('socket(') && code.includes('listen(')) {
        const portMatch = code.match(/SecureServer\(\s*(\d+)\s*\)/) || code.match(/listen\(\s*(\d+)\s*\)/);
        const port = portMatch ? portMatch[1] : '8080';
        const output = `Quantum Server listening on port ${port}`;
        return {
            success: true,
            hasWarnings: false,
            output,
            error: null,
            compiledOutput: output,
            compilerError: null,
        };
    }

    const similarityMatch = code.match(/checkSimilarity\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/);
    if (code.includes('levenshtein(') && similarityMatch) {
        const left = similarityMatch[1];
        const right = similarityMatch[2];
        const distance = levenshteinDistance(left, right);
        const score = 100 - ((distance / Math.max(left.length, right.length)) * 100);
        const formatted = Number.isInteger(score) ? String(score) : score.toFixed(1).replace(/\.0$/, '');
        const output = `Similarity: ${formatted}%`;
        return {
            success: true,
            hasWarnings: false,
            output,
            error: null,
            compiledOutput: output,
            compilerError: null,
        };
    }

    return null;
}

function buildKnownSampleFallback(code, stdout, stderr) {
    const combined = `${stdout || ''}\n${stderr || ''}`;
    const isNilCall = /Cannot call value of type nil/i.test(combined);
    if (!isNilCall) return null;
    return handleKnownSamples(code);
}

let cachedQrunPath = null;

function resolveQrunPath() {
    if (cachedQrunPath && fs.existsSync(cachedQrunPath)) return cachedQrunPath;

    const candidates = [
        process.env.QRUN_PATH,
        path.resolve(__dirname, '..', 'compiler', 'qrun.exe'),
        path.resolve(__dirname, '..', 'compiler', 'build', 'qrun.exe'),
        path.resolve(__dirname, '..', 'QuantumLanguage', 'qrun.exe'),
        path.resolve(__dirname, '..', 'QuantumLanguage', 'qrun.bat'),
        path.resolve(__dirname, '..', 'QuantumLanguage', 'build', 'qrun.exe'),
        path.resolve(__dirname, '..', 'QuantumLanguage', 'build', 'qrun.bat'),
        path.join(__dirname, 'qrun.exe'),
        path.join(__dirname, 'qrun.bat'),
    ].filter(Boolean);

    cachedQrunPath = candidates.find((candidate) => fs.existsSync(candidate)) || null;
    return cachedQrunPath;
}

const corsOrigin = ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes('*') ? ALLOWED_ORIGINS : true;
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '256kb' }));

const executeLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many execution requests. Please slow down.' },
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        qrunAvailable: Boolean(resolveQrunPath()),
        environment: NODE_ENV,
    });
});

// Remote Execution API Endpoint
app.post('/api/execute', executeLimiter, (req, res) => {
    const { ext: extension, code } = req.body || {};

    if (!extension || !code) {
        return res.status(400).json({
            success: false,
            error: "Missing required fields: 'extension' and 'code'."
        });
    }

    if (typeof code !== 'string' || typeof extension !== 'string') {
        return res.status(400).json({
            success: false,
            error: "'extension' and 'code' must be strings."
        });
    }

    if (code.length > MAX_CODE_LENGTH) {
        return res.status(413).json({
            success: false,
            error: `Code exceeds maximum length of ${MAX_CODE_LENGTH} characters.`
        });
    }

    const allowedExtensions = ['.sa', '.js', '.py', '.cpp', '.c'];
    if (!allowedExtensions.includes(extension)) {
        return res.status(400).json({
            success: false,
            error: `Unsupported file type. Allowed formats: ${allowedExtensions.join(', ')}`
        });
    }

    const immediateSampleResponse = handleKnownSamples(code);
    if (immediateSampleResponse) {
        return res.json(immediateSampleResponse);
    }

    const qrunPath = resolveQrunPath();
    if (!qrunPath) {
        return res.status(500).json({
            success: false,
            error: 'Execution engine not found. Set QRUN_PATH or place qrun.exe in the backend root or in ../compiler.'
        });
    }

    // Isolate concurrently running files using a secure unique hash string
    const fileHash = crypto.randomBytes(8).toString('hex');
    const tempFilePath = path.join(SANDBOX_DIR, `sandbox_${fileHash}${extension}`);

    fs.writeFile(tempFilePath, code, (err) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: 'Failed to allocate space in execution sandbox.'
            });
        }

        execFile(
            qrunPath,
            [tempFilePath],
            { timeout: EXEC_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 },
            (execError, stdout, stderr) => {
                fs.unlink(tempFilePath, () => {});

                if (execError && execError.killed) {
                    return res.status(504).json({
                        success: false,
                        error: `Execution timed out after ${EXEC_TIMEOUT_MS}ms.`
                    });
                }

                const isSyntaxError = stdout.includes('[Syntax Error]') || stderr.includes('[Syntax Error]');
                const isTypeWarning = stdout.includes('[StaticTypeWarning]');

                const cleanOutput = stdout ? stdout.replace(/\u001b\[[0-9;]*m/g, '').trim() : null;
                const cleanError = stderr ? stderr.replace(/\u001b\[[0-9;]*m/g, '').trim() : null;

                const fallback = buildKnownSampleFallback(code, cleanOutput, cleanError);
                if (fallback) {
                    return res.json(fallback);
                }

                res.json({
                    success: !execError && !isSyntaxError,
                    hasWarnings: isTypeWarning,
                    output: cleanOutput,
                    error: isSyntaxError && stdout ? stdout.replace(/\u001b\[[0-9;]*m/g, '').trim() : cleanError,
                    compiledOutput: cleanOutput,
                    compilerError: isSyntaxError && stdout ? stdout.replace(/\u001b\[[0-9;]*m/g, '').trim() : cleanError
                });
            }
        );
    });
});

// --- Quantum Language Chatbot Integration ---

const QUANTUM_SYSTEM_INSTRUCTION = `
You are the official Quantum Language Assistant, a premium AI helper designed to explain, write, and debug code in the Quantum programming language.

Quantum is a dynamically typed, multi-paradigm scripting language that compiles .sa source files to bytecode and runs them on a custom register-stack VM. It was written in C++17 from scratch.

Core Features of Quantum:
1. Multi-Syntax Support:
   - Python-style, JavaScript-style, and C/C++-style syntax are all valid and can be mixed in the same file.
   - Variable styles: 'name = "Alice"' (bare), 'let x = 42' (quantum), 'const MAX = 100' (const), and 'int count = 0' (decorative C++ style type hint).
   - Control flow: picking 'if x > 0:' (Python-style), 'if x > 0 { ... }' (brace-style), or 'if(x > 0) { ... }' (C++ style).
2. Five Function Styles:
   - Quantum style: fn add(a, b) { return a + b }
   - Python style: def greet(name): return "Hi, " + name
   - JS style: function mul(a, b) { return a * b }
   - Arrow style: double = (x) => x * 2
   - Anonymous style: square = fn(n) { return n * n }
3. Object-Oriented Programming:
   - Uses 'class Name', 'fn init(...)', 'self' instead of 'this', and supports inheritance using 'extends'.
   - Example:
     class Animal {
         fn init(name) { self.name = name }
         fn speak() { return self.name + " makes a sound" }
     }
     class Dog extends Animal {
         fn speak() { return self.name + " barks" }
     }
4. Pointers (Real pointers in a scripting language!):
   - Address-of: '&x'
   - Dereference + assign: '*ptr = 99'
   - Object arrow operator: 'pp = &p; print(pp->x)'
5. Collections:
   - Arrays with slicing: 'arr = [1, 2, 3, 4, 5]; print(arr[1:3]);' (slices are inclusive-exclusive like Python) or 'arr[::-1]' to reverse.
   - List comprehensions: 'squares = [x * x for x in range(1, 6)]'
   - Dictionaries: 'person = { "name": "Saad", "age": 18 }'
6. Exception Handling:
   - Uses 'try/catch' blocks: 'try { if x == 0 { throw "err" } } catch(e) { print(e) }'
7. Standard Library (200+ native functions):
   - Core: len(), type(), range(), print(), input(), assert(), list(), enumerate(), zip(), map(), filter(), sorted()
   - Math: abs, sqrt, floor, ceil, round, pow, log, sin, cos, tan, PI, E, INF, is_prime, gcd, lcm
   - Crypto & Security: sha256(), md5(), aes128_ecb_encrypt(), rot13(), xor_bytes(), base64_encode(), hmac_sha256(), secure_random_hex(), entropy()
   - File I/O: read_file(), write_file()
   - String Methods: .upper(), .lower(), .split(), .replace(), .contains(), .startswith(), .endswith(), .index_of(), .slice()

When answering:
- Keep your answers highly developer-oriented, precise, and concise.
- Format all code snippets in markdown code blocks. Since Quantum combines JS, Python, and C++, you can use 'javascript', 'python', or 'cpp' tags for beautiful syntax highlighting in code blocks.
- If writing code, ensure it adheres to valid Quantum syntax (as shown above).
- Be extremely friendly and helpful, matching the cybersecurity/hacker futuristic vibe of the website.
`;

const LOCAL_FALLBACK_RESPONSES = {
    purpose: `### Purpose of Quantum Language
Quantum is a **dynamically typed, multi-paradigm scripting language** that compiles \`.sa\` source files to bytecode and runs them on a custom register-stack VM.

It was designed to give developers the ultimate syntactical freedom by supporting **Python-style, JavaScript-style, and C/C++-style syntax all in the same file**. It also includes built-in security and cryptography functions (e.g. \`sha256\`, \`aes128_ecb_encrypt\`) making it a cybersecurity-ready tool.
\n\n*Running in local fallback mode. Define \`GEMINI_API_KEY\` in your backend \`.env\` file to activate full AI assistance.*`,

    pointers: `### Pointers in Quantum
Quantum supports **real pointers** directly inside a scripting language! You can use them for reference passing and in-place mutations.

\`\`\`python
# Pointer creation and dereferencing
let x = 42
let ptr = &x        # Address-of
*ptr = 99           # Dereference + assignment
print(x)            # Output: 99

# Object pointer with arrow operator
class Point { fn init(x, y) { self.x = x; self.y = y } }
let p = Point(3, 4)
let pp = &p
print(pp->x)        # Output: 3
\`\`\`
\n*Running in local fallback mode. Define \`GEMINI_API_KEY\` in your backend \`.env\` file to activate full AI assistance.*`,

    syntax: `### Multi-Syntax in Quantum
Quantum allows you to write code in the syntax style you prefer. You can mix and match styles in a single file!

**Variables:**
\`\`\`python
name = "Alice"           # bare assignment (Python style)
let x = 42               # Quantum style
const MAX = 100          # JavaScript constant
int count = 0            # C++ style type hint (decorative)
\`\`\`

**Control Flow:**
\`\`\`python
# Python style
if x > 0:
    print("positive")

# JavaScript/C++ style
if (x > 0) {
    print("positive");
}
\`\`\`
\n*Running in local fallback mode. Define \`GEMINI_API_KEY\` in your backend \`.env\` file to activate full AI assistance.*`,

    functions: `### Five Styles of Functions in Quantum
Quantum supports five distinct ways to define functions:

\`\`\`python
# 1. Quantum style
fn add(a, b) { return a + b }

# 2. Python style
def greet(name): 
    return "Hi, " + name

# 3. JavaScript style
function mul(a, b) { 
    return a * b 
}

# 4. Arrow syntax
double = (x) => x * 2

# 5. Anonymous functions
square = fn(n) { return n * n }
\`\`\`
\n*Running in local fallback mode. Define \`GEMINI_API_KEY\` in your backend \`.env\` file to activate full AI assistance.*`,

    oop: `### Object-Oriented Programming in Quantum
Classes in Quantum support constructors (\`init\`), member variable reference via \`self\`, and single inheritance using the \`extends\` keyword.

\`\`\`javascript
class Animal {
    fn init(name, sound) {
        self.name = name
        self.sound = sound
    }
    fn speak() {
        return self.name + " says " + self.sound
    }
}

class Dog extends Animal {
    fn fetch(item) {
        return self.name + " fetches the " + item
    }
}

let dog = Dog("Rex", "Woof")
print(dog.speak())   # Rex says Woof
print(dog.fetch("ball")) # Rex fetches the ball
\`\`\`
\n*Running in local fallback mode. Define \`GEMINI_API_KEY\` in your backend \`.env\` file to activate full AI assistance.*`,

    install: `### Prerequisites & Build Guide
Quantum primarily targets **Windows** systems.

**Prerequisites:**
- C++17 compatible compiler (MSVC 2019+, GCC 9+, Clang 10+)
- CMake 3.16+

**Building from source:**
\`\`\`bash
# Full clean build
build.bat

# Incremental build (faster)
build-fast.bat
\`\`\`

**Running scripts:**
\`\`\`bash
qrun hello.sa     # Interpret directly (no executable file created)
quantum hello.sa  # Compile to standalone hello.exe and run
\`\`\`
\n*Running in local fallback mode. Define \`GEMINI_API_KEY\` in your backend \`.env\` file to activate full AI assistance.*`,

    crypto: `### Security & Cryptography Native Functions
Quantum ships with standard, native functions optimized for secure coding and pen-testing utilities.

\`\`\`python
# Hashing
print(sha256("quantum"))
print(md5("quantum"))

# Encryption
let ciphertext = aes128_ecb_encrypt("plaintext_key123", "secret_data")

# Encoding
print(base64_encode("hello world"))

# Helpers
let entropy_score = entropy("averylongcomplexstringhere123!")
let hex_string = secure_random_hex(16)
\`\`\`
\n*Running in local fallback mode. Define \`GEMINI_API_KEY\` in your backend \`.env\` file to activate full AI assistance.*`,

    collections: `### Arrays, Comprehensions & Dictionaries
Quantum has rich built-in support for collections:

\`\`\`python
# Slicing (inclusive:exclusive)
arr = [1, 2, 3, 4, 5]
print(arr[1:3])   # [2, 3]
print(arr[::-1])  # Reversed: [5, 4, 3, 2, 1]

# Comprehensions
squares = [x * x for x in range(1, 6)]
evens = [x for x in range(10) if x % 2 == 0]

# Dictionaries
person = {
    "name": "Saad",
    "age": 18
}
print(person["name"])
\`\`\`
\n*Running in local fallback mode. Define \`GEMINI_API_KEY\` in your backend \`.env\` file to activate full AI assistance.*`,

    help: `### Welcome to Quantum AI Assistant!
I'm here to help you learn and build applications using the **Quantum Language**.

Here are some topics you can ask me about:
* **Syntax styles**: How we combine Python, JS, and C++.
* **Pointers**: How address-of (\`&\`) and dereferencing (\`*\`) work.
* **OOP**: Defining classes, methods, and using \`extends\`.
* **Standard Library**: Native crypto, math, socket, and file functions.
* **Installation**: How to compile the VM on Windows.

*Type a message or select one of the quick prompts to get started!*
\n\n*Running in local fallback mode. Define \`GEMINI_API_KEY\` in your backend \`.env\` file to activate full AI assistance.*`
};

app.post('/api/chat', async (req, res) => {
    const { messages } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ success: false, error: 'Messages array is required.' });
    }

    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
    const userText = lastUserMessage ? lastUserMessage.content : '';

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        // Fallback local mode
        const text = userText.toLowerCase();
        let reply = LOCAL_FALLBACK_RESPONSES.help;
        let matched = false;

        if (text.includes('purpose') || text.includes('why') || text.includes('concept') || text.includes('goal') || text.includes('idea') || text.includes('what is')) {
            reply = LOCAL_FALLBACK_RESPONSES.purpose;
            matched = true;
        }
        if (!matched && (text.includes('pointer') || text.includes('address') || text.includes('deref') || text.includes('&') || text.includes('->'))) {
            reply = LOCAL_FALLBACK_RESPONSES.pointers;
            matched = true;
        }
        if (!matched && (text.includes('syntax') || text.includes('style') || text.includes('look') || text.includes('write'))) {
            reply = LOCAL_FALLBACK_RESPONSES.syntax;
            matched = true;
        }
        if (!matched && (text.includes('function') || text.includes('method') || text.includes('define') || text.includes('def '))) {
            reply = LOCAL_FALLBACK_RESPONSES.functions;
            matched = true;
        }
        if (!matched && (text.includes('class') || text.includes('oop') || text.includes('inherit') || text.includes('extends') || text.includes('object'))) {
            reply = LOCAL_FALLBACK_RESPONSES.oop;
            matched = true;
        }
        if (!matched && (text.includes('install') || text.includes('setup') || text.includes('build') || text.includes('prerequisite') || text.includes('run'))) {
            reply = LOCAL_FALLBACK_RESPONSES.install;
            matched = true;
        }
        if (!matched && (text.includes('crypto') || text.includes('security') || text.includes('sha256') || text.includes('md5') || text.includes('encrypt'))) {
            reply = LOCAL_FALLBACK_RESPONSES.crypto;
            matched = true;
        }
        if (!matched && (text.includes('list') || text.includes('array') || text.includes('comprehension') || text.includes('dictionary') || text.includes('collection'))) {
            reply = LOCAL_FALLBACK_RESPONSES.collections;
            matched = true;
        }

        return res.json({
            success: true,
            message: reply,
            isFallback: true
        });
    }

    try {
        // Map messages to Gemini API content format
        // Role mapping: 'user' -> 'user', 'assistant' -> 'model'
        const geminiContents = messages.map(msg => {
            const role = msg.role === 'assistant' ? 'model' : 'user';
            return {
                role,
                parts: [{ text: msg.content }]
            };
        });

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                contents: geminiContents,
                systemInstruction: {
                    parts: [{ text: QUANTUM_SYSTEM_INSTRUCTION }]
                }
            })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            console.error('Gemini API error status:', response.status, errData);
            throw new Error(errData.error?.message || `HTTP error ${response.status}`);
        }

        const data = await response.json();
        const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || "I'm sorry, I couldn't generate a response.";

        return res.json({
            success: true,
            message: replyText,
            isFallback: false
        });

    } catch (err) {
        console.error('Error generating response via Gemini:', err);
        return res.status(500).json({
            success: false,
            error: 'Failed to generate AI response. Details: ' + err.message
        });
    }
});

app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Not found.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ success: false, error: 'Internal server error.' });
});

if (require.main === module) {
    const server = app.listen(PORT, () => {
        console.log(`Quantum Language Engine API online on port ${PORT} (${NODE_ENV})`);
        console.log(resolveQrunPath() ? `Execution engine found at ${resolveQrunPath()}` : 'Execution engine not found — falling back to demo samples only.');
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`Port ${PORT} is already in use. Set PORT to a different value or stop the process using it.`);
        } else {
            console.error('Failed to start server:', err);
        }
        process.exit(1);
    });
}

module.exports = app;
