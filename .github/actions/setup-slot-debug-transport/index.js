const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const TOOL_DIR = path.join(process.env.RUNNER_TEMP || os.tmpdir(), "setup-slot-debug-transport");
const LOG_DIR = path.join(TOOL_DIR, "logs");
const GOST_REPO_LATEST_RELEASE = "https://api.github.com/repos/go-gost/gost/releases/latest";
const CLOUDFLARED_LINUX_AMD64 =
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";

function getInput(name, { required = false } = {}) {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  const value = (process.env[key] || "").trim();
  if (required && !value) {
    throw new Error(`Input required and not supplied: ${name}`);
  }
  return value;
}

function maskSecret(value) {
  if (value) {
    process.stdout.write(`::add-mask::${value}${os.EOL}`);
  }
}

function logInfo(message) {
  process.stdout.write(`${message}${os.EOL}`);
}

function writeEnvFile(filePath, key, value) {
  if (!filePath) {
    return;
  }
  fs.appendFileSync(filePath, `${key}=${value}${os.EOL}`, { encoding: "utf8" });
}

function setOutput(name, value) {
  writeEnvFile(process.env.GITHUB_OUTPUT, name, value);
}

function saveState(name, value) {
  writeEnvFile(process.env.GITHUB_STATE, name, value);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

async function downloadFile(url, destination, headers = {}) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "setup-slot-debug-transport",
      ...headers,
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Download failed for ${url}: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, buffer);
}

function chmodExecutable(filePath) {
  fs.chmodSync(filePath, 0o755);
}

function findExecutableOnPath(name) {
  const pathValue = process.env.PATH || "";
  for (const part of pathValue.split(path.delimiter)) {
    if (!part) {
      continue;
    }
    const candidate = path.join(part, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_error) {
      // Ignore missing and non-executable candidates.
    }
  }
  return null;
}

function findFileRecursively(rootDir, fileName) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const nested = findFileRecursively(fullPath, fileName);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

async function ensureCloudflaredBinary() {
  const existing = findExecutableOnPath("cloudflared");
  if (existing) {
    return existing;
  }

  ensureDir(TOOL_DIR);
  const cloudflaredPath = path.join(TOOL_DIR, "cloudflared");
  if (!fs.existsSync(cloudflaredPath)) {
    logInfo("Downloading cloudflared for slot debug transport");
    await downloadFile(CLOUDFLARED_LINUX_AMD64, cloudflaredPath);
    chmodExecutable(cloudflaredPath);
  }
  return cloudflaredPath;
}

async function ensureGostBinary() {
  const existing = findExecutableOnPath("gost");
  if (existing) {
    return existing;
  }

  ensureDir(TOOL_DIR);
  const gostPath = path.join(TOOL_DIR, "gost");
  if (fs.existsSync(gostPath)) {
    return gostPath;
  }

  logInfo("Downloading gost for slot debug transport");
  const releaseResponse = await fetch(GOST_REPO_LATEST_RELEASE, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "setup-slot-debug-transport",
    },
    redirect: "follow",
  });
  if (!releaseResponse.ok) {
    throw new Error(
      `Failed to query gost latest release: ${releaseResponse.status} ${releaseResponse.statusText}`,
    );
  }

  const release = await releaseResponse.json();
  const asset = (release.assets || []).find((candidate) =>
    /^gost_.*_linux_amd64\.tar\.gz$/.test(candidate.name || ""),
  );
  if (!asset || !asset.browser_download_url) {
    throw new Error("Could not find a Linux amd64 gost release asset");
  }

  const archivePath = path.join(TOOL_DIR, asset.name);
  const extractDir = path.join(TOOL_DIR, "gost-extract");
  await downloadFile(asset.browser_download_url, archivePath);
  ensureDir(extractDir);

  const extract = spawnSync("tar", ["-xzf", archivePath, "-C", extractDir], {
    encoding: "utf8",
  });
  if (extract.status !== 0) {
    throw new Error(`Failed to extract gost archive: ${extract.stderr || extract.stdout}`.trim());
  }

  const extractedBinary = findFileRecursively(extractDir, "gost");
  if (!extractedBinary) {
    throw new Error("Extracted gost archive does not contain a gost binary");
  }

  fs.copyFileSync(extractedBinary, gostPath);
  chmodExecutable(gostPath);
  return gostPath;
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a local TCP port")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function isProcessRunning(pid) {
  if (!pid || Number.isNaN(Number(pid))) {
    return false;
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (connected) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function readLogSnippet(logPath) {
  if (!logPath || !fs.existsSync(logPath)) {
    return "";
  }
  const content = fs.readFileSync(logPath, "utf8");
  const lines = content.trim().split(/\r?\n/);
  return lines.slice(-20).join(os.EOL);
}

async function waitForPort(port, label, processInfo, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) {
      return;
    }
    if (processInfo && processInfo.pid && !isProcessRunning(processInfo.pid)) {
      const snippet = readLogSnippet(processInfo.logPath);
      throw new Error(
        `${label} process exited before localhost:${port} was reachable` +
          (snippet ? `${os.EOL}${snippet}` : ""),
      );
    }
    await sleep(500);
  }

  const snippet = processInfo ? readLogSnippet(processInfo.logPath) : "";
  throw new Error(
    `Timed out waiting for ${label} to listen on localhost:${port}` +
      (snippet ? `${os.EOL}${snippet}` : ""),
  );
}

function spawnDetached(command, args, logPath) {
  ensureDir(path.dirname(logPath));
  const logFd = fs.openSync(logPath, "a");
  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  fs.closeSync(logFd);
  child.unref();
  return child;
}

async function terminateProcess(pid, label) {
  if (!pid || !isProcessRunning(pid)) {
    return;
  }

  const numericPid = Number(pid);
  const signals = ["SIGTERM", "SIGKILL"];
  for (const signal of signals) {
    try {
      process.kill(-numericPid, signal);
    } catch (error) {
      if (error && error.code !== "ESRCH") {
        try {
          process.kill(numericPid, signal);
        } catch (singleError) {
          if (singleError && singleError.code !== "ESRCH") {
            throw singleError;
          }
        }
      }
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!isProcessRunning(numericPid)) {
        return;
      }
      await sleep(500);
    }
  }

  logInfo(`Transport cleanup could not fully stop ${label} pid ${numericPid}`);
}

async function cleanupFromState() {
  if (process.env.STATE_TRANSPORT_ACTIVE !== "1") {
    return;
  }

  await terminateProcess(process.env.STATE_GOST_PID, "gost");
  await terminateProcess(process.env.STATE_CLOUDFLARED_PID, "cloudflared");
}

async function main() {
  const enabled = getInput("enabled") === "true";
  if (!enabled) {
    return;
  }

  const hostname = getInput("upterm-hostname", { required: true });
  const gostUsername = getInput("upterm-gost-username", { required: true });
  const gostPassword = getInput("upterm-gost-password", { required: true });

  maskSecret(gostUsername);
  maskSecret(gostPassword);

  ensureDir(LOG_DIR);

  const cloudflaredBinary = await ensureCloudflaredBinary();
  const gostBinary = await ensureGostBinary();

  const cfLocalPort = await allocatePort();
  const uptermLocalPort = await allocatePort();

  const cloudflaredLogPath = path.join(LOG_DIR, "cloudflared.log");
  const gostLogPath = path.join(LOG_DIR, "gost.log");

  let cloudflaredProcess;
  let gostProcess;

  try {
    const cloudflaredArgs = [
      "access",
      "tcp",
      "--hostname",
      hostname,
      "--url",
      `localhost:${cfLocalPort}`,
    ];
    cloudflaredProcess = spawnDetached(cloudflaredBinary, cloudflaredArgs, cloudflaredLogPath);
    await waitForPort(
      cfLocalPort,
      "cloudflared access tcp",
      { pid: cloudflaredProcess.pid, logPath: cloudflaredLogPath },
      30000,
    );

    const encodedUsername = encodeURIComponent(gostUsername);
    const encodedPassword = encodeURIComponent(gostPassword);
    const forwardUrl =
      `forward+ssh://${encodedUsername}:${encodedPassword}@127.0.0.1:${cfLocalPort}`;
    maskSecret(forwardUrl);

    const gostArgs = [
      "-L",
      `tcp://127.0.0.1:${uptermLocalPort}`,
      "-F",
      forwardUrl,
    ];
    gostProcess = spawnDetached(gostBinary, gostArgs, gostLogPath);
    await waitForPort(
      uptermLocalPort,
      "gost forwarder",
      { pid: gostProcess.pid, logPath: gostLogPath },
      30000,
    );

    saveState("TRANSPORT_ACTIVE", "1");
    saveState("CLOUDFLARED_PID", String(cloudflaredProcess.pid));
    saveState("GOST_PID", String(gostProcess.pid));

    setOutput("server_url", `ssh://127.0.0.1:${uptermLocalPort}`);
    setOutput("cf_local_port", String(cfLocalPort));
    setOutput("upterm_local_port", String(uptermLocalPort));

    logInfo(`Slot debug transport ready on ssh://127.0.0.1:${uptermLocalPort}`);
  } catch (error) {
    await terminateProcess(gostProcess && gostProcess.pid, "gost");
    await terminateProcess(cloudflaredProcess && cloudflaredProcess.pid, "cloudflared");
    throw error;
  }
}

async function run() {
  try {
    if (process.env.STATE_TRANSPORT_ACTIVE) {
      await cleanupFromState();
      return;
    }
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}${os.EOL}`);
    process.exitCode = 1;
  }
}

run();
