const config = require("../config");
const { runCode, stripAnsi, cleanSandboxPath } = require("../services/qrun.service");
const { handleKnownSamples, buildKnownSampleFallback } = require("../services/samples.service");

async function execute(req, res) {
  const { ext: extension, code } = req.body || {};

  if (!extension || !code) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: 'extension' and 'code'.",
    });
  }

  if (typeof code !== "string" || typeof extension !== "string") {
    return res.status(400).json({
      success: false,
      error: "'extension' and 'code' must be strings.",
    });
  }

  if (code.length > config.MAX_CODE_LENGTH) {
    return res.status(413).json({
      success: false,
      error: `Code exceeds maximum length of ${config.MAX_CODE_LENGTH} characters.`,
    });
  }

  if (!config.ALLOWED_EXTENSIONS.includes(extension)) {
    return res.status(400).json({
      success: false,
      error: `Unsupported file type. Allowed formats: ${config.ALLOWED_EXTENSIONS.join(", ")}`,
    });
  }

  // Demo-mode shortcut for known frontend samples.
  const immediateSampleResponse = handleKnownSamples(code);
  if (immediateSampleResponse) {
    return res.json(immediateSampleResponse);
  }

  const result = await runCode(code, extension);

  if (result.noBinary) {
    return res.status(500).json({
      success: false,
      error:
        "Execution engine not found. Set QRUN_PATH or place qrun.exe in the backend root or in ../compiler.",
    });
  }

  if (result.writeError) {
    return res.status(500).json({
      success: false,
      error: "Failed to allocate space in execution sandbox.",
    });
  }

  const { execError, stdout, stderr } = result;

  if (execError && execError.killed) {
    return res.status(504).json({
      success: false,
      error: `Execution timed out after ${config.EXEC_TIMEOUT_MS}ms.`,
    });
  }

  const isSyntaxError = stdout.includes("[Syntax Error]") || stderr.includes("[Syntax Error]");
  const isTypeWarning = stdout.includes("[StaticTypeWarning]");

  const cleanOutput = cleanSandboxPath(stripAnsi(stdout));
  const cleanError = cleanSandboxPath(stripAnsi(stderr));

  const fallback = buildKnownSampleFallback(code, cleanOutput, cleanError);
  if (fallback) {
    return res.json(fallback);
  }

  res.json({
    success: !execError && !isSyntaxError,
    hasWarnings: isTypeWarning,
    output: cleanOutput,
    error: isSyntaxError && stdout ? cleanSandboxPath(stripAnsi(stdout)) : cleanError,
    compiledOutput: cleanOutput,
    compilerError: isSyntaxError && stdout ? cleanSandboxPath(stripAnsi(stdout)) : cleanError,
  });
}

module.exports = { execute };