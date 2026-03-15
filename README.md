# omp-pi-install

Install Pi plugins in [Oh My Pi](https://github.com/can1357/oh-my-pi) from GitHub, with automatic import remapping.

Pi plugins use `@mariozechner/pi-*` imports. OMP uses `@oh-my-pi/pi-*`. This extension handles the translation transparently so you can install any Pi plugin with a single command.

## Install

```bash
git clone https://github.com/rayoplateado/omp-pi-install /tmp/omp-pi-install \
  && cp -r /tmp/omp-pi-install/extensions/pi-install ~/.omp/agent/extensions/ \
  && rm -rf /tmp/omp-pi-install
```

Then run `/reload` inside OMP.

## Usage

```
/pi-install davebcn87/pi-autoresearch
/pi-install https://github.com/user/repo
```

After installing, run `/reload` to activate the new plugin.

### Commands

| Command | Description |
|---|---|
| `/pi-install <user/repo>` | Install a Pi plugin from GitHub |
| `/pi-uninstall <name>` | Remove an installed plugin |
| `/pi-list` | List installed Pi plugins |
| `/pi-update [name]` | Update one or all installed plugins |

## What it does

1. Clones the repo (`--depth 1`)
2. Reads `package.json` manifest (`omp` or `pi` key), or detects `extensions/` and `skills/` dirs by convention
3. Copies extensions to `~/.omp/agent/extensions/`
4. Copies skills to `~/.omp/agent/skills/`
5. Remaps all `@mariozechner/pi-*` imports to `@oh-my-pi/pi-*`
6. Tracks installs in `~/.omp/agent/pi-plugins.json` for uninstall/update support
7. Cleans up temp files

## Import remapping

The following scopes are automatically remapped:

| Pi (original) | OMP (remapped) |
|---|---|
| `@mariozechner/pi-coding-agent` | `@oh-my-pi/pi-coding-agent` |
| `@mariozechner/pi-agent-core` | `@oh-my-pi/pi-agent-core` |
| `@mariozechner/pi-ai` | `@oh-my-pi/pi-ai` |
| `@mariozechner/pi-tui` | `@oh-my-pi/pi-tui` |
| `@mariozechner/pi-utils` | `@oh-my-pi/pi-utils` |

## License

MIT
