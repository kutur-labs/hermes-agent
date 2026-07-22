# Marcel on Fly.io

This fork runs the Hermes gateway as the internal agent **Marcel**. The Fly
Machine has no public service. Administrative access is provided by Tailscale
SSH, and both Hermes and Tailscale state persist on the `hermes_data` volume.

## Deployment

Runtime secrets belong in Fly, never in this repository:

```sh
fly secrets set TS_AUTHKEY=tskey-auth-...
fly deploy
```

The Tailscale key is only needed for first enrollment. The node persists its
identity under `/opt/data/tailscale`.

## First-time Hermes setup

Connect from a device on the same tailnet:

```sh
ssh root@marcel
hermes setup
exit
```

The container's `hermes` shim restores `HERMES_HOME=/opt/data` for
environment-sanitized Tailscale SSH sessions, so setup and status commands use
the same persistent configuration as the supervised gateway.

Then restart the Machine so the gateway reloads its configuration:

```sh
fly machine restart --app kutur-labs-marcel
```

Model-provider and messaging-platform credentials are Hermes configuration;
they are intentionally not baked into the image or committed to the fork.
