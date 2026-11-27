#!/usr/bin/env node
// Gives the Worker its Web Push (VAPID) keypair, once. The deploy runs it
// after every upload (.github/workflows/deploy.yml); after the first, it
// finds the pair already there and does nothing. Run in worker/, with the
// same Cloudflare credentials as any wrangler command.
//
// The pair is generated here rather than kept in Vault because nothing
// outside this Worker needs it, and because it must never change: every
// browser's push subscription is bound to the public key it subscribed with,
// so a new pair silently ends pushes to every device that turned
// notifications on. Hence:
//   - an existing pair is always kept;
//   - half a pair, or an answer from wrangler this can't read, stops the
//     deploy rather than guessing, since a wrong guess replaces the pair;
//   - both halves go up in one `secret bulk` request, so a failure can't
//     leave half a pair behind.
// The private key goes to wrangler on stdin and is never printed.

import { spawnSync } from "node:child_process";

const NAMES = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"];

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function wrangler(args, input) {
  const r = spawnSync("npx", ["wrangler", ...args], { input, encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"] });
  if (r.error) fail(`Couldn't run wrangler: ${r.error.message}`);
  return r;
}

/** The Worker's secret names, or a failed deploy: never a guess. */
function secretNames() {
  const r = wrangler(["secret", "list", "--format", "json"]);
  if (r.status !== 0) fail("wrangler secret list failed, so it isn't known whether the Worker has a VAPID keypair. Not generating one.");
  return new Set(parseList(r.stdout).map((s) => s.name));
}

/**
 * The JSON array in wrangler's output. Wrangler can print notes (a newer
 * version, a proxy) before or after it, some with brackets in them, so this
 * takes the first run of lines that opens with "[", closes with "]", and
 * parses as a list of secrets. Anything else fails the deploy.
 */
function parseList(out) {
  const lines = out.split("\n");
  for (let a = 0; a < lines.length; a++) {
    if (!lines[a].startsWith("[")) continue;
    for (let b = a; b < lines.length; b++) {
      if (!lines[b].trimEnd().endsWith("]")) continue;
      try {
        const list = JSON.parse(lines.slice(a, b + 1).join("\n"));
        if (Array.isArray(list) && list.every((s) => typeof s?.name === "string")) return list;
      } catch {
        // not this run of lines
      }
    }
  }
  fail(`wrangler secret list answered in a shape this doesn't read, so it isn't known whether the Worker has a VAPID keypair. Not generating one.\n${out.slice(0, 500)}`);
}

const names = secretNames();
const present = NAMES.filter((n) => names.has(n));
if (present.length === NAMES.length) {
  console.log("The Worker already has its VAPID keypair; keeping it.");
  process.exit(0);
}
if (present.length) {
  fail(
    `The Worker has ${present[0]} but not the other half of its VAPID keypair. A new pair would end pushes to every device that turned notifications on, so that's left to a person: delete ${present[0]} with \`wrangler secret delete\` and the next deploy makes a new pair.`,
  );
}

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);

const put = wrangler(["secret", "bulk"], JSON.stringify({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: d }));
if (put.status !== 0) fail(`wrangler secret bulk failed:\n${put.stdout}`);
console.log(`Gave the Worker a new VAPID keypair (public key ${publicKey}).`);
