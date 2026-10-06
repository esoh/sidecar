import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkRoute } from "./cloudflare-tunnel.mjs";

const exec = promisify(execFile);
const script = fileURLToPath(
  new URL("./cloudflare-tunnel.mjs", import.meta.url),
);
const id = "11111111-1111-4111-8111-111111111111";
const connectorId = "22222222-2222-4222-8222-222222222222";
const routes = [
  { hostname: "first.example.com", service: "http://localhost:4002" },
  {
    hostname: "unrelated.example.com",
    service: "http://127.0.0.1:8123",
    originRequest: { httpHostHeader: "unrelated.example.com" },
  },
  { service: "http_status:404" },
];

// No real binary, account, config, listener, or external service is consulted.
const fake = `
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const home=process.env.HOME, args=process.argv.slice(2);
if(process.env.TUNNEL_URL||process.env.CLOUDFLARED_CONFIG)process.exit(97);
const config=JSON.parse(fs.readFileSync(args[args.indexOf('--config')+1],'utf8'));
const active=path.join(home,'active.json');
if(args.includes('validate'))process.exit(0);
if(args.includes('info')){
  if(process.env.FAKE_QUERY_FAIL){console.error('private fixture configuration');process.exit(5);}
  if(process.env.FAKE_EXIT_DURING_INFO&&fs.existsSync(active)){
    process.kill(Number(fs.readFileSync(path.join(home,'pid'),'utf8')),'SIGTERM');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);
  }
  let conns=fs.existsSync(active)?[{id:'${connectorId}',conns:[]}]:null;
  if(process.env.FAKE_EXTRA)conns=[...(conns??[]),{id:'33333333-3333-4333-8333-333333333333',conns:[]}];
  if(process.env.FAKE_PENDING)conns=[{id:'33333333-3333-4333-8333-333333333333',conns:[{is_pending_reconnect:true}]}];
  const info={id:config.tunnel,name:'local-services',createdAt:'2026-01-01T00:00:00Z',conns};
  if(process.env.FAKE_MALFORMED)delete info.conns;
  console.log(JSON.stringify(info));process.exit(0);
}
if(!args.includes('run'))process.exit(9);
if(process.env.FAKE_EXIT)process.exit(7);
fs.appendFileSync(path.join(home,'launches'),'1');
fs.writeFileSync(path.join(home,'pid'),String(process.pid));
fs.writeFileSync(path.join(home,'launch.json'),JSON.stringify({cwd:process.cwd(),args}));
const server=http.createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/diag/tunnel')res.end(JSON.stringify({tunnelID:config.tunnel,connectorID:'${connectorId}'}));
  else if(req.url==='/config')res.end(JSON.stringify({version:-1,config}));
  else if(req.url==='/ready'){res.statusCode=process.env.FAKE_UNREADY?503:200;res.end('{}');}
  else{res.statusCode=404;res.end('{}');}
});
server.listen(Number(config.metrics.split(':')[1]),'127.0.0.1',()=>{
  fs.writeFileSync(active,'{}');
  if(process.env.FAKE_MUTATE)fs.appendFileSync(args[args.indexOf('--config')+1],' ');
});
process.on('SIGTERM',()=>{fs.rmSync(active,{force:true});server.close(()=>process.exit(process.env.FAKE_EXIT_DURING_INFO?7:0));});
setTimeout(()=>process.exit(8),45000).unref();
`;

async function fixture(t) {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "cloudflare-test-")),
  );
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "cloudflared"), `#!${process.execPath}\n${fake}`, {
    mode: 0o755,
  });
  await writeFile(
    join(bin, "ps"),
    `#!${process.execPath}\nconsole.log(process.env.FAKE_UNKNOWN ? 'cloudflared' : 'node');`,
    { mode: 0o755 },
  );
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const configPath = join(home, "shared config;literal.yml");
  const config = {
    tunnel: id,
    "credentials-file": join(home, "credentials.json"),
    metrics: `127.0.0.1:${port}`,
    ingress: routes,
  };
  const save = () => writeFile(configPath, JSON.stringify(config));
  await save();
  t.after(async () => {
    try {
      process.kill(
        Number(await readFile(join(home, "pid"), "utf8")),
        "SIGKILL",
      );
    } catch {}
    await rm(home, { recursive: true, force: true });
  });
  const run = async (index = 0, env = {}, target = routes[index].service) => {
    const { stdout } = await exec(
      process.execPath,
      [
        script,
        "--config",
        configPath,
        "--public-url",
        `https://${routes[index].hostname}`,
        "--target",
        target,
      ],
      {
        env: { ...process.env, HOME: home, PATH: bin, ...env },
        timeout: 12000,
      },
    );
    return JSON.parse(stdout);
  };
  return { home, configPath, config, save, run, bin };
}

test("route validation rejects shadows, missing/stale targets, and Host overrides", () => {
  checkRoute(
    { ingress: routes },
    "https://first.example.com",
    "http://localhost:4002",
  );
  for (const ingress of [
    [...routes.slice(0, -1), { service: "http://localhost:9999" }],
    routes.slice(1),
    [{ ...routes[0], service: "http://localhost:4999" }, ...routes.slice(1)],
    [
      { hostname: "*.example.com", service: "http://localhost:4002" },
      ...routes,
    ],
    [{ ...routes[0], path: "/health" }, ...routes.slice(1)],
    [
      { ...routes[0], originRequest: { httpHostHeader: "localhost" } },
      ...routes.slice(1),
    ],
  ]) {
    assert.throws(() =>
      checkRoute(
        { ingress },
        "https://first.example.com",
        "http://localhost:4002",
      ),
    );
  }
});

test(
  "either startup order reuses one connector and client exit preserves unknown routes",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      const f = await fixture(t);
      const before = await readFile(f.configPath, "utf8");
      const overrides = {
        TUNNEL_URL: "http://localhost:9999",
        CLOUDFLARED_CONFIG: "unselected.yml",
      };
      const first = await f.run(order[0], overrides);
      const second = await f.run(order[1], overrides);
      assert.equal(first.status, "started");
      assert.equal(second.status, "reused");
      assert.equal(first.connectorId, second.connectorId);
      assert.equal(await readFile(join(f.home, "launches"), "utf8"), "1");
      assert.equal(await readFile(f.configPath, "utf8"), before);
      assert.equal(
        JSON.parse(await readFile(join(f.home, "launch.json"), "utf8")).cwd,
        f.home,
      );
      process.kill(Number(await readFile(join(f.home, "pid"), "utf8")), 0);
      const live = await (
        await fetch(`http://${f.config.metrics}/config`)
      ).json();
      assert.deepEqual(live.config.ingress, routes);
    }
  },
);

test(
  "concurrent starts serialize and start one connector",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const results = await Promise.all([f.run(0), f.run(1)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [
      "reused",
      "started",
    ]);
    assert.equal(await readFile(join(f.home, "launches"), "utf8"), "1");
  },
);

test(
  "unknown local processes/replicas and query failures fail without starting",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.run(0, { FAKE_UNKNOWN: "1" }),
      /Another local cloudflared process/,
    );
    await assert.rejects(f.run(0, { FAKE_EXTRA: "1" }), /another connector/);
    await assert.rejects(
      f.run(0, { FAKE_PENDING: "1" }),
      /--show-recently-disconnected.*until Cloudflare drops them/,
    );
    await assert.rejects(f.run(0, { FAKE_MALFORMED: "1" }), /Unrecognized/);
    await assert.rejects(f.run(0, { FAKE_QUERY_FAIL: "1" }), (error) => {
      assert.match(error.stderr, /tunnel info failed \(exit 5\)/);
      assert.match(error.stderr, /origincert/);
      assert.doesNotMatch(
        error.stderr,
        /private fixture configuration|No connector was replaced/,
      );
      return true;
    });
    await assert.rejects(f.run(0, { PATH: f.home }), /missing from PATH/);
    await assert.rejects(readFile(join(f.home, "launches")), {
      code: "ENOENT",
    });
  },
);

test(
  "live stale route, metrics conflict, and extra replicas never restart a shared connector",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await f.run();
    await assert.rejects(f.run(0, { FAKE_EXTRA: "1" }), /another connector/);
    f.config.ingress = [
      { ...routes[0], service: "http://localhost:4999" },
      ...routes.slice(1),
    ];
    await f.save();
    await assert.rejects(f.run(), /missing or stale/);
    await assert.rejects(
      f.run(0, {}, "http://localhost:4999"),
      /missing or stale/,
    );
    f.config.tunnel = "44444444-4444-4444-8444-444444444444";
    f.config.ingress = routes;
    await f.save();
    await assert.rejects(f.run(), /different or unverifiable tunnel/);
    assert.equal(await readFile(join(f.home, "launches"), "utf8"), "1");
    process.kill(Number(await readFile(join(f.home, "pid"), "utf8")), 0);
  },
);

test(
  "failed startup and concurrent config edits leave no reusable failed child or lock",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.run(0, { FAKE_EXIT: "1" }),
      /exited before readiness/,
    );
    await assert.rejects(
      f.run(0, { FAKE_MUTATE: "1" }),
      /config changed during startup/,
    );
    await assert.rejects(readFile(join(f.home, "active.json")), {
      code: "ENOENT",
    });
    await assert.rejects(
      readFile(join(f.home, ".cloudflared/local-connectors", id, "start.lock")),
      { code: "ENOENT" },
    );
  },
);

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGHUP", 129],
]) {
  test(
    `${signal} during unpublished startup cleans its child and lock`,
    { skip: process.platform === "win32", timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const child = spawn(
        process.execPath,
        [
          script,
          "--config",
          f.configPath,
          "--public-url",
          "https://first.example.com",
          "--target",
          "http://localhost:4002",
        ],
        {
          env: { ...process.env, HOME: f.home, PATH: f.bin, FAKE_UNREADY: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      t.after(() => child.kill("SIGKILL"));
      const exited = once(child, "exit");
      let pid;
      for (let i = 0; i < 100; i++) {
        try {
          pid = Number(await readFile(join(f.home, "pid"), "utf8"));
          break;
        } catch {}
        await delay(50);
      }
      assert.ok(pid, "fake connector must start");
      child.kill(signal);
      const [code] = await exited;
      assert.equal(code, exitCode);
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      await assert.rejects(
        readFile(
          join(f.home, ".cloudflared/local-connectors", id, "start.lock"),
        ),
        { code: "ENOENT" },
      );
    },
  );
}

test(
  "child exit during postflight cannot publish startup success",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.run(0, { FAKE_EXIT_DURING_INFO: "1" }),
      /Connector exited.*connector\.log/,
    );
    const pid = Number(await readFile(join(f.home, "pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assert.rejects(
      readFile(join(f.home, ".cloudflared/local-connectors", id, "start.lock")),
      { code: "ENOENT" },
    );
  },
);

test(
  "a delayed connection refusal permits startup without treating timeouts as absence",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const preload = join(f.home, "delayed-fetch.mjs");
    await writeFile(
      preload,
      `
const fetchNormally=globalThis.fetch;
let isFirst=true;
globalThis.fetch=(url,options)=>{
  if(!isFirst||!String(url).endsWith('/diag/tunnel'))return fetchNormally(url,options);
  isFirst=false;
  if(process.env.FAKE_PROBE_TIMEOUT)return Promise.reject(new DOMException('timed out','TimeoutError'));
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new TypeError('fetch failed',{cause:{code:'ECONNREFUSED'}})),2300);
    options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(options.signal.reason);},{once:true});
  });
};
`,
    );
    await assert.rejects(
      f.run(0, {
        NODE_OPTIONS: `--import=${preload}`,
        FAKE_PROBE_TIMEOUT: "1",
      }),
      /Cannot verify the configured connector diagnostics/,
    );
    await assert.rejects(readFile(join(f.home, "launches")), {
      code: "ENOENT",
    });
    assert.equal(
      (await f.run(0, { NODE_OPTIONS: `--import=${preload}` })).status,
      "started",
    );
  },
);

test("public route rejects required Access while preserving unrelated protection", () => {
  const access = {
    required: true,
    teamName: "example",
    audTag: ["example-audience"],
  };
  for (const config of [
    { originRequest: { access }, ingress: routes },
    {
      ingress: [
        { ...routes[0], originRequest: { access } },
        ...routes.slice(1),
      ],
    },
  ]) {
    assert.throws(
      () =>
        checkRoute(
          config,
          "https://first.example.com",
          "http://localhost:4002",
        ),
      /must not require Cloudflare Access/,
    );
  }
  const config = {
    originRequest: { access },
    ingress: [
      { ...routes[0], originRequest: { access: { required: false } } },
      { ...routes[1], originRequest: { access } },
      routes[2],
    ],
  };
  const before = JSON.stringify(config);
  checkRoute(config, "https://first.example.com", "http://localhost:4002");
  assert.equal(JSON.stringify(config), before);
});

test("hostname precedence follows native IDNA and literal wildcard matching", () => {
  const publicUrl = "https://first.xn--bcher-kva.example";
  const own = {
    hostname: "first.xn--bcher-kva.example",
    service: "http://localhost:4002",
  };
  const last = { service: "http_status:404" };
  for (const hostname of ["first.bücher.example", "*.xn--bcher-kva.example"]) {
    assert.throws(() =>
      checkRoute(
        {
          ingress: [{ hostname, service: "http://localhost:8123" }, own, last],
        },
        publicUrl,
        "http://localhost:4002",
      ),
    );
  }
  checkRoute(
    { ingress: [{ ...own, hostname: "first.bücher.example" }, last] },
    publicUrl,
    "http://localhost:4002",
  );
  for (const hostname of ["*.bücher.example", "*.XN--BCHER-KVA.EXAMPLE"]) {
    checkRoute(
      { ingress: [{ hostname, service: "http://localhost:8123" }, own, last] },
      publicUrl,
      "http://localhost:4002",
    );
  }
  for (const hostname of [
    "first.xn--bcher-kva.example/extra",
    "first.xn--bcher-kva.example?query",
    "first.xn--bcher-kva.example#fragment",
    "first.xn--bcher-kva.example\\extra",
  ]) {
    assert.throws(
      () =>
        checkRoute(
          { ingress: [{ ...own, hostname }, last] },
          publicUrl,
          "http://localhost:4002",
        ),
      /without URL syntax/,
    );
  }
  for (const hostname of ["0x7f000001", "０x７f０００００１"]) {
    assert.throws(() =>
      checkRoute(
        { ingress: [{ ...own, hostname }, last] },
        "https://127.0.0.1",
        "http://localhost:4002",
      ),
    );
  }
  checkRoute(
    {
      ingress: [
        { hostname: "FIRST_.example", service: "http://localhost:8123" },
        { ...own, hostname: "first_.example" },
        last,
      ],
    },
    "https://first_.example",
    "http://localhost:4002",
  );
});
