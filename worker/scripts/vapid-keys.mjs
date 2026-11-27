#!/usr/bin/env node
// Creates hdctl's Web Push (VAPID) keypair and stores it in Vault at
// kv/github/hdctl/push, where the deploy reads it. Needs the vault CLI,
// signed in with write access to that path.
//
//   npm run vapid-keys -w worker            # store a new pair, unless one exists
//   npm run vapid-keys -w worker -- --force # replace it (see below first)
//
// The private key is handed to vault on stdin and never printed, so it isn't
// left in a terminal's scrollback or a shell's history.
//
// Run it once. Every browser subscription is bound to the public key it
// subscribed with, so a new pair silently stops pushes to every device that
// already turned notifications on: each has to turn them off and on again.
// Hence the refusal to overwrite without --force.

import { spawnSync } from "node:child_process";

const PATH = "kv/github/hdctl/push";
const force = process.argv.includes("--force");

const vault = (args, input) => spawnSync("vault", args, { input, encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });

const probe = vault(["kv", "get", "-field=VAPID_PUBLIC_KEY", PATH]);
if (probe.error) {
  console.error(`Couldn't run the vault CLI (${probe.error.message}). Install it and sign in, then run this again.`);
  process.exit(1);
}
if (probe.status === 0 && !force) {
  console.error(`${PATH} already holds a VAPID pair (public key ${probe.stdout.trim()}).`);
  console.error("Replacing it stops pushes to every device until each turns notifications on again. Use --force if that's what you want.");
  process.exit(1);
}

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);

// `KEY=-` makes vault read that value from stdin.
const put = vault(["kv", "put", PATH, `VAPID_PUBLIC_KEY=${publicKey}`, "VAPID_PRIVATE_KEY=-"], d);
if (put.status !== 0) {
  console.error(`vault kv put ${PATH} failed:\n${put.stderr || put.stdout}`);
  process.exit(1);
}
console.log(`Stored a new VAPID pair at ${PATH} (public key ${publicKey}).`);
console.log("The next deploy syncs it to the Worker. For local dev, copy both values into worker/.dev.vars from Vault.");
