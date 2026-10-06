# Sidecar on your own domain with Cloudflare Tunnel

Use a locally managed **named tunnel** and a hostname you control. [Quick Tunnels do not support SSE](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), which Sidecar needs for live updates. This guide uses generic placeholders; keep real domains, tunnel IDs, account details, credentials, and local paths outside the public repository.

For a full DNS setup using Universal SSL, choose a first-level hostname such as `sidecar.example.com`. Deeper names require additional certificate coverage; see [Universal SSL limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).

## One-time setup

Install `cloudflared` and prepare a domain on Cloudflare following its [official setup guide](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/). Authorize in your browser, then create a dedicated tunnel and DNS route:

```sh
cloudflared tunnel login
cloudflared tunnel create sidecar-local
cloudflared tunnel route dns sidecar-local sidecar.example.com
```

To share an existing tunnel, retain its UUID, account certificate, and common ingress file. For a hostname in another zone in the **same Cloudflare account**, keep the existing certificate for `tunnel info` and create the DNS record in that zone's dashboard instead of logging in again: **DNS → Records → Add record**, type **CNAME**, name `sidecar`, target `TUNNEL_UUID.cfargotunnel.com`, and **Proxied**. Preserve unrelated records. Tunnel DNS records must belong to the tunnel's account; see [Cloudflare's DNS routing guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/).

Keep the account certificate `cert.pem` created by `cloudflared tunnel login` available at its default location, or set an absolute `origincert` path in the YAML. Every start **and reuse** queries the Cloudflare API through `tunnel info` to detect unknown replicas; the tunnel credentials JSON alone is insufficient. The helper ignores `TUNNEL_*` and `CLOUDFLARED_*` environment overrides, so configure certificate and tunnel settings in YAML. If a query fails, the error names the failed subcommand and exit code; inspect native diagnostics privately rather than publishing raw stderr.

These are explicit infrastructure setup steps, not actions the Sidecar skill performs during routine startup. A connector may also serve other local services. Use one canonical ingress file containing every hostname; each service validates only its own hostname/target and preserves the others. Multiple documents from one Sidecar owner share a hostname; another owner needs a different endpoint.

In the original attached agent, run `sidecar network on --owner KEY`. Retain the returned passphrase privately and use its **tunnelTarget** port below. Never use the ordinary localhost viewer port.

Create a private `~/.cloudflared/sidecar.yml`, substituting the tunnel ID, existing credentials-file path, hostname, and protected port:

```yaml
tunnel: TUNNEL_UUID
credentials-file: /absolute/private/path/TUNNEL_UUID.json
metrics: 127.0.0.1:20123
ingress:
  - hostname: sidecar.example.com
    service: http://127.0.0.1:PROTECTED_PORT
  - hostname: api.example.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

Do not add Host/Origin overrides. The Sidecar route must not require connector-side Cloudflare Access validation (`originRequest.access.required: true`), including a top-level default. An explicit `required: false` on this route is compatible; leave unrelated protected routes intact. The helper reports incompatible settings rather than editing them. See Cloudflare's [configuration reference](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/) for ingress rules. Validate before running:

```sh
cloudflared tunnel --config ~/.cloudflared/sidecar.yml ingress validate
cloudflared tunnel --config ~/.cloudflared/sidecar.yml ingress rule https://sidecar.example.com
cloudflared tunnel --config ~/.cloudflared/sidecar.yml info --show-recently-disconnected sidecar-local
```

Keep the config outside Git checkouts; persistent connectors must not inherit worktree ownership. The metrics address must be a fixed, unused **loopback** port; never expose it publicly. The second hostname above is an illustrative unrelated service, not a required route. Keep your existing routes intact.

Add the Cloudflare JSON shown in the [README](../README.md#over-the-internet-with-ngrok-or-cloudflare) to your machine-local Sidecar config, then use:

```sh
sidecar cloudflare --owner KEY
```

This starts or reuses the configured connector and allows Sidecar's public origin. It requires the protected listener to be enabled first. It checks native tunnel identity, actual loaded ingress, readiness, and other replicas; merely finding a process or reading YAML is insufficient. A compatible connector started by another service can be reused. Concurrent launchers using the same generic UUID lock start only one connector. The connector runs detached from a neutral directory and survives either service exiting.

Public HTTPS should show Sidecar's passphrase form. Log in, verify the intended document and streaming, and confirm agent-only routes remain blocked. Keep certificate verification enabled. The public link is `https://sidecar.example.com/?document=DOCUMENT_ID` (or `/?library=1`).

Thereafter ask Codex or Claude to open Sidecar over the internet; both use this workflow. Sidecar has no tunnel supervisor, app ownership registry, or reference counts.

## Restarts and conflicts

Sidecar restarts disable network access and clear the public origin. Re-enable access and compare the new protected target with the connector's loaded ingress. A stale/missing route is an explicit error. To repair it, coordinate downtime with any users of that connector, update only the intended hostname's service, validate the complete config, and restart the identified connector. Routine Sidecar startup does none of those disruptive steps. Editing YAML alone does not update a running connector.

The checked-in launcher uses `~/.cloudflared/local-connectors/TUNNEL_UUID/start.lock` (an atomic directory) and `connector.log`. The UUID is lowercase. Other local launchers can use the same narrow convention without knowing anything about Sidecar. A fixed loopback metrics address provides native `/diag/tunnel`, `/config`, and `/ready` evidence. The helper also checks Cloudflare's connector list so an unknown replica cannot silently receive requests with different routing. It does not adopt ownership or keep app references. See the [generic launcher source](../scripts/cloudflare-tunnel.mjs) for the exact contract.

Unknown connectors remain a conflict even when pending or recently disconnected. Inspect `cloudflared tunnel --config ~/.cloudflared/sidecar.yml info --show-recently-disconnected TUNNEL_UUID` privately; wait for Cloudflare to drop disconnected entries before retrying. The diagnostic flag does not relax the replica check.

If the configured diagnostics endpoint is absent and any unverified local `cloudflared` process exists, automatic startup is refused—even if that process might use another UUID. Confirm its configuration and make diagnostics available, or coordinate an explicit connector start; do not assume a disconnected process is gone. A lock/readiness timeout or incompatible connector requires the concrete action reported by the command. Do not automatically remove a lock, launch a divergent same-ID replica, kill by process name, overwrite unknown routes, or infer live routing from a file alone.

`sidecar network off --owner KEY` stops remote access to that viewer; the shared connector keeps serving unrelated hostnames. A separate explicit connector shutdown must account for every service using it. Keep the Mac awake while using remote access.

## Monitor traffic

In the Cloudflare dashboard, select your domain → **Analytics → Requests** (some dashboard versions label the view **Traffic / HTTP Traffic**). Select a time range and read **Total data transfer / Bandwidth** and its graph. Where available, filter by your Sidecar hostname; compare the same period before and after changes. Request counts are not byte totals.

Cloudflare's [zone analytics](https://developers.cloudflare.com/analytics/account-and-zone-analytics/zone-analytics/) reports HTTP response data at the edge. It can lag and does not include direct localhost/LAN visits or all transport overhead. Plan-dependent filters and labels can differ. `cloudflared tunnel info` and connector logs show connection health, not account bandwidth quotas.

For a local check without a public tunnel, use browser DevTools → Network and its **Transferred** total while exercising a scratch document. Capture idle time, a streamed reply, and a reload separately. Avoid exporting HAR files from real documents: those can contain conversation text and credentials. For ngrok, compare its [Usage](https://dashboard.ngrok.com/usage) and [Billing](https://dashboard.ngrok.com/billing) dashboards; keep request inspection disabled. Check current provider terms rather than assuming a bandwidth allowance is permanent.
