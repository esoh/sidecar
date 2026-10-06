#!/usr/bin/env node
// Generic local connector startup. No app registry, config writes, or stop API.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, open, readFile, realpath, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { domainToASCII, fileURLToPath } from "node:url";
import { promisify, parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { load } from "js-yaml";

const exec = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const action =
  "Preserve all ingress routes; coordinate any config/port update and connector restart with its owner. No connector was replaced.";
const fail = (message) => {
  throw new Error(`${message} ${action}`);
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Validation and launch must ignore the same tunnel/config environment overrides.
const connectorEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("TUNNEL_") && !key.startsWith("CLOUDFLARED_"),
    ),
  );

function origin(value, isPublic) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("Expected a valid public URL and local target.");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (isPublic
      ? url.protocol !== "https:" || url.port || url.hostname.includes("*")
      : url.protocol !== "http:" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  ) {
    fail(
      "Use an HTTPS public origin and an HTTP loopback target, without a path or credentials.",
    );
  }
  return url;
}

// Requiring an unshadowed, whole-host rule avoids approximating Go path regexes.
export function checkRoute(config, publicUrl, target) {
  const host = origin(publicUrl, true).hostname;
  const expected = origin(target, false).origin;
  if (!Array.isArray(config?.ingress)) fail("Missing ingress rules.");
  const last = config.ingress.at(-1);
  if (
    !last ||
    last.hostname ||
    last.path ||
    last.service !== "http_status:404"
  ) {
    fail(
      "End the common ingress config with a hostless, pathless http_status:404 catch-all.",
    );
  }
  for (const rule of config.ingress) {
    const raw = rule?.hostname ?? "";
    if (
      typeof raw !== "string" ||
      /[\s\u0000-\u001f\u007f/\\?#:@%\[\]]/u.test(raw)
    )
      fail("Ingress hostnames must contain a hostname, without URL syntax.");
    // Go's IDNA lookup rejects wildcards and invalid DNS labels: those rules
    // match literally. The suffix prevents Node from interpreting IPv4 syntax.
    const ascii = raw.includes("*")
      ? ""
      : domainToASCII(`${raw}.invalid`).slice(0, -8);
    const name =
      ascii &&
      ascii
        .split(".")
        .every(
          (label) =>
            !label ||
            (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) &&
              (label.slice(2, 4) !== "--" || label.startsWith("xn--"))),
        )
        ? ascii
        : raw;
    const canMatch =
      !name ||
      name === "*" ||
      name === host ||
      (name.startsWith("*.") && host.endsWith(name.slice(1)));
    if (!canMatch) continue;
    if (name !== host || rule.path)
      fail(`Add an unshadowed, pathless ingress rule for ${host}.`);
    let service;
    try {
      service = new URL(rule.service);
    } catch {
      fail(`Invalid target for ${host}.`);
    }
    if (
      service.origin !== expected ||
      service.pathname !== "/" ||
      service.search ||
      service.hash ||
      service.username ||
      service.password
    ) {
      fail(
        `The ingress target for ${host} must be ${expected}; the route is missing or stale.`,
      );
    }
    const hostHeader =
      rule.originRequest?.httpHostHeader ??
      config.originRequest?.httpHostHeader;
    if (hostHeader && hostHeader.toLowerCase() !== host)
      fail(`The Host override for ${host} changes its public hostname.`);
    const access = rule.originRequest?.access ?? config.originRequest?.access;
    if (access?.required)
      fail(
        `The public route for ${host} must not require Cloudflare Access authentication.`,
      );
    return;
  }
  fail(`Missing ingress route for ${host}.`);
}

export async function cloudflarePlan({ configPath, publicUrl, target }) {
  const path = await realpath(
    configPath.startsWith("~/")
      ? join(homedir(), configPath.slice(2))
      : resolve(configPath),
  );
  const bytes = await readFile(path);
  let config;
  try {
    config = load(bytes.toString("utf8"));
  } catch {
    fail("Invalid Cloudflare YAML; inspect the config locally.");
  }
  if (
    !uuid.test(config?.tunnel ?? "") ||
    config?.token ||
    config?.["token-file"]
  )
    fail("Use a locally managed tunnel UUID, not a name or token.");
  if (
    typeof config.metrics !== "string" ||
    !/^127\.0\.0\.1:([1-9][0-9]{0,4})$/.test(config.metrics) ||
    Number(config.metrics.split(":")[1]) > 65535
  ) {
    fail(
      "Set a fixed metrics: 127.0.0.1:PORT in the common Cloudflare config.",
    );
  }
  if (
    typeof config["credentials-file"] !== "string" ||
    !isAbsolute(config["credentials-file"])
  )
    fail("Use an absolute credentials-file path in the Cloudflare config.");
  if (
    config.origincert !== undefined &&
    (typeof config.origincert !== "string" || !isAbsolute(config.origincert))
  )
    fail("Use an absolute origincert path.");
  checkRoute(config, publicUrl, target);
  return {
    configPath: path,
    publicUrl: origin(publicUrl, true).origin,
    target: origin(target, false).origin,
    tunnelId: config.tunnel.toLowerCase(),
    metrics: config.metrics,
    configHash: digest(bytes),
  };
}

async function run(args, signal) {
  try {
    return await exec("cloudflared", args, {
      env: connectorEnv(),
      signal,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === "ENOENT")
      throw new Error(
        "cloudflared is missing from PATH; install it before starting a Cloudflare tunnel.",
      );
    const operation = args.includes("info") ? "info" : "ingress validate";
    // Native stderr may include configuration contents. Let the operator inspect it privately.
    throw new Error(
      `cloudflared tunnel ${operation} failed (exit ${error.code ?? "unknown"}). Run cloudflared tunnel --config <selected-config> ${operation} ${operation === "info" ? "--output json <tunnel-UUID> " : ""}directly for details. ${operation === "info" ? "Keep cert.pem available or set origincert in the YAML; TUNNEL_* and CLOUDFLARED_* environment overrides are ignored." : "Inspect the selected ingress rules."}`,
    );
  }
}

async function getJSON(base, path, signal) {
  // A closed loopback port can take several seconds to refuse on Windows.
  const timeout = path === "/diag/tunnel" ? 10000 : 2000;
  const response = await fetch(`${base}${path}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    redirect: "error",
  });
  if (!response.ok) fail(`Connector diagnostics ${path} are unavailable.`);
  try {
    return await response.json();
  } catch {
    fail(`Connector diagnostics ${path} returned invalid JSON.`);
  }
}

async function inspect(plan, signal) {
  const base = `http://${plan.metrics}`;
  let tunnel;
  try {
    tunnel = await getJSON(base, "/diag/tunnel", signal);
  } catch (error) {
    signal.throwIfAborted();
    if (error.cause?.code === "ECONNREFUSED") return null;
    fail(
      "Cannot verify the configured connector diagnostics; do not start a duplicate.",
    );
  }
  if (
    tunnel.tunnelID?.toLowerCase() !== plan.tunnelId ||
    !uuid.test(tunnel.connectorID ?? "")
  )
    fail("The metrics address belongs to a different or unverifiable tunnel.");
  const live = await getJSON(base, "/config", signal);
  checkRoute(live.config, plan.publicUrl, plan.target);
  const ready = await fetch(`${base}/ready`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
    redirect: "error",
  });
  return { connectorId: tunnel.connectorID, isReady: ready.ok };
}

async function checkReplicas(plan, connectorId, signal) {
  const { stdout } = await run(
    [
      "tunnel",
      "--config",
      plan.configPath,
      "info",
      "--output",
      "json",
      plan.tunnelId,
    ],
    signal,
  );
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    fail("Cannot verify other connectors for this tunnel.");
  }
  if (
    info.id?.toLowerCase() !== plan.tunnelId ||
    !("conns" in info) ||
    (info.conns !== null && !Array.isArray(info.conns))
  )
    fail("Unrecognized cloudflared tunnel info response.");
  // cloudflared Info uses "conns"; a nil Go slice serializes as null.
  // https://github.com/cloudflare/cloudflared/blob/master/cmd/cloudflared/tunnel/info.go
  if (
    (info.conns ?? []).some(
      (entry) => !uuid.test(entry?.id ?? "") || entry.id !== connectorId,
    )
  )
    fail(
      "This tunnel has another connector whose loaded routes cannot be verified. Inspect cloudflared tunnel --config <selected-config> info --show-recently-disconnected <tunnel-UUID>; recently disconnected connectors also block startup until Cloudflare drops them, then retry.",
    );
}

async function hasUnknownProcess() {
  try {
    if (process.platform === "win32") {
      const { stdout } = await exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop'; @(Get-Process -Name cloudflared -ErrorAction SilentlyContinue).Count",
        ],
        { timeout: 5000 },
      );
      if (!/^\d+\s*$/.test(stdout)) throw new Error();
      return Number(stdout) > 0;
    }
    const { stdout } = await exec("ps", ["-A", "-o", "comm="], {
      timeout: 5000,
    });
    return stdout
      .split("\n")
      .some((line) => /(^|\/)cloudflared$/.test(line.trim()));
  } catch {
    fail(
      "Cannot establish that no unverified local cloudflared process is running.",
    );
  }
}

export async function ensureCloudflareTunnel(options) {
  const plan = await cloudflarePlan(options);
  const directory = join(
    homedir(),
    ".cloudflared",
    "local-connectors",
    plan.tunnelId,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "start.lock");
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        fail(
          `Startup lock is busy: ${lock}. Wait for the starter; if it crashed, verify no startup is active before removing this empty lock directory.`,
        );
      await delay(200);
    }
  }
  let child;
  let isShared = false;
  const controller = new AbortController();
  const { signal } = controller;
  const interrupt = () =>
    controller.abort(
      Object.assign(new Error("Cloudflare startup interrupted."), {
        exitCode: 130,
      }),
    );
  const terminate = () =>
    controller.abort(
      Object.assign(new Error("Cloudflare startup terminated."), {
        exitCode: 143,
      }),
    );
  const hangup = () =>
    controller.abort(
      Object.assign(new Error("Cloudflare startup disconnected."), {
        exitCode: 129,
      }),
    );
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  process.on("SIGHUP", hangup);
  try {
    const unchanged = async () => {
      signal.throwIfAborted();
      if (digest(await readFile(plan.configPath)) !== plan.configHash)
        fail(
          "Cloudflare config changed during startup; retry after the edit is complete.",
        );
    };
    await unchanged();
    await run(
      ["tunnel", "--config", plan.configPath, "ingress", "validate"],
      signal,
    );
    let live = await inspect(plan, signal);
    if (live) {
      if (!live.isReady)
        fail(
          "The existing connector is not ready; inspect its owner/logs instead of starting a replica.",
        );
      await checkReplicas(plan, live.connectorId, signal);
      await unchanged();
      return { status: "reused", ...plan, connectorId: live.connectorId };
    }
    await checkReplicas(plan, undefined, signal);
    if (await hasUnknownProcess())
      fail(
        "Another local cloudflared process exists, but the configured metrics endpoint is absent. Have its owner expose verifiable diagnostics or start the intended connector explicitly.",
      );
    await unchanged();
    const logPath = join(directory, "connector.log");
    const log = await open(logPath, "a", 0o600);
    try {
      child = spawn(
        "cloudflared",
        [
          "tunnel",
          "--config",
          plan.configPath,
          "--no-autoupdate",
          "run",
          plan.tunnelId,
        ],
        {
          cwd: homedir(),
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
          env: connectorEnv(),
        },
      );
      await once(child, "spawn");
    } finally {
      await log.close();
    }
    const readyDeadline = Date.now() + 30000;
    do {
      if (child.exitCode !== null || child.signalCode !== null)
        fail(`Connector exited before readiness. Inspect ${logPath}.`);
      live = await inspect(plan, signal);
      if (live?.isReady) break;
      await delay(200, undefined, { signal });
    } while (Date.now() < readyDeadline);
    if (!live?.isReady)
      fail(`Connector did not become ready. Inspect ${logPath}.`);
    await checkReplicas(plan, live.connectorId, signal);
    await unchanged();
    if (child.exitCode !== null || child.signalCode !== null)
      fail(`Connector exited before startup completed. Inspect ${logPath}.`);
    isShared = true;
    child.unref();
    return {
      status: "started",
      ...plan,
      connectorId: live.connectorId,
      logPath,
    };
  } finally {
    // Only this not-yet-published child is ours to stop; never signal a reused one.
    if (child && !isShared) {
      child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([once(child, "exit"), delay(2000)]);
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
    }
    await rmdir(lock);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.off("SIGHUP", hangup);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        config: { type: "string" },
        "public-url": { type: "string" },
        target: { type: "string" },
      },
    });
    if (!values.config || !values["public-url"] || !values.target)
      throw new Error(
        "Usage: cloudflare-tunnel.mjs --config PATH --public-url HTTPS_ORIGIN --target HTTP_LOOPBACK_ORIGIN",
      );
    console.log(
      JSON.stringify(
        await ensureCloudflareTunnel({
          configPath: values.config,
          publicUrl: values["public-url"],
          target: values.target,
        }),
      ),
    );
  } catch (error) {
    console.error(`[cloudflare] ${error.message}`);
    process.exitCode = error.exitCode ?? error.cause?.exitCode ?? 1;
  }
}
