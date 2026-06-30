const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json()); 

// Remote Execution API Endpoint
app.post('/api/execute', (req, res) => {
    const { extension, code } = req.body;

    // Payload validation
    if (!extension || !code) {
        return res.status(400).json({ 
            success: false, 
            error: "Missing required fields: 'extension' and 'code'." 
        });
    }

    const allowedExtensions = ['.sa', '.js', '.cpp', '.c'];
    if (!allowedExtensions.includes(extension)) {
        return res.status(400).json({ 
            success: false, 
            error: `Unsupported file type. Allowed formats: ${allowedExtensions.join(', ')}` 
        });
    }

    // Isolate concurrently running files using a secure unique hash string
    const fileHash = crypto.randomBytes(8).toString('hex');
    const tempFileName = `sandbox_${fileHash}${extension}`;
    const tempFilePath = path.join(__dirname, tempFileName);

    // Save payload to a transient sandbox file
    fs.writeFile(tempFilePath, code, (err) => {
        if (err) {
            return res.status(500).json({ 
                success: false, 
                error: "Failed to allocate space in execution sandbox." 
            });
        }

        // Programmatic system execution calling your compiled binary tool
        const command = `.\\qrun ${tempFileName}`;

            exec(command, (execError, stdout, stderr) => {
            // Instantly delete the file from your disk storage array
            fs.unlink(tempFilePath, () => {}); 

            // Track paradigm rules and custom compiler triggers
            const isSyntaxError = stdout.includes('[Syntax Error]') || stderr.includes('[Syntax Error]');
            const isTypeWarning = stdout.includes('[StaticTypeWarning]');

            // Clean ANSI escape color codes from the output strings
            const cleanOutput = stdout ? stdout.replace(/\u001b\[[0-9;]*m/g, '').trim() : null;
            const cleanError = stderr ? stderr.replace(/\u001b\[[0-9;]*m/g, '').trim() : null;

            // Return standardized clean JSON payload back to client webpage
            res.json({
                success: !execError && !isSyntaxError,
                hasWarnings: isTypeWarning,
                compiledOutput: cleanOutput,
                compilerError: isSyntaxError && stdout ? stdout.replace(/\u001b\[[0-9;]*m/g, '').trim() : cleanError
            });
        });
    });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Quantum Language Engine API online on port ${PORT}`);
});