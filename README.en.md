# haruyuki-gui

English · [Simplified Chinese](README.md)

> **AIGC Statement**: The code and documentation of this project are largely generated with AI assistance and then reviewed, adjudicated, and verified by human maintainers. AI-generated content may contain logic errors, outdated information, or security flaws; this project is provided **"AS IS"**. Before use or redistribution, please review, test, and assess risks yourself. If you find problems, you are welcome to report them in the repository's issues.

## 1. What This Project Is

**Haruyuki-gui is a desktop application based on Haruyuki, along with derivative plugins that provide similar functionality.**

Haruyuki itself is a cost-saving companion agent runtime with complex mechanisms and rich use cases; a TUI can no longer meet the needs of long-term use.

Therefore, Haruyuki-gui is dedicated to giving it a usable and beautiful GUI, making long-term and multi-scenario use possible. Our design strives to stay close to everyday scenarios, but there may still be oversights; we ask for your understanding and welcome contributions of different ideas.

The project is still in its early stages, and there is no usable application yet. Please check back later.

### Our Goals

| Goal | Meaning |
| ---- | ------- |
| **All-in-one, easy-to-use desktop application** | Cover the full capabilities needed for daily use, rather than a window that can only chat; its derivative plugins will also strive to do the same. |
| **Fully local and self-contained** | No dependence on any cloud service. State, data, and configuration all reside on your own machine. |
| **Good visual design and visualization** | The interface itself must be good-looking and the information understandable—turning a powerful runtime into an application people are willing to open every day. |

## 2. Current Status

> **Infrastructure is still under development; there is currently no usable build.**

The repository currently contains only the engineering foundation: workspace skeleton, package-boundary gates, gate self-tests, and commit hooks. **There is no usable application, no build artifacts, and no way to launch it.**

Please check back later. Meanwhile—**contributions to this project are still very welcome**, and suggestions or ideas are also welcome. The development plan below describes the blueprint and current progress; it does not represent implemented features.

## 3. Development Plan

- [x] **Engineering Foundation**: workspace skeleton, package-boundary gates, gate self-tests, commit hooks
- [ ] **Engine Boundary**: engine process supervision and connection handshake, event main loop, capability mapping
- [ ] **Shared Kernel**: event coalescing, session state, render bridge frame layer
- [ ] **Desktop Shell**: Electron skeleton and security baseline, host capability adaptation, inter-process transport
- [ ] **Presentation Layer**: application framework, docking layout, page registry
- [ ] **Pages and Command Surface**: feature pages and command palette
- [ ] **Distribution and Quality**: self-contained runtime, packaging and release process
- [ ] **VSCode Track**: extension skeleton, webview host, runtime supervision

The order is determined by dependencies, not by numbering. A checkmark only means "landed and guarded by gates"; it does not mean the feature is usable.

If you are going to touch code: first run `pnpm install` (requires Node 24 and corepack); after changes, ensure `pnpm verify` passes—that single command is all the gates.

## 4. License

Released under the Apache License 2.0; see [LICENSE](LICENSE) for the full text.

- [NOTICE](NOTICE) records third-party attributions that must be propagated with distributions and specifies when new entries need to be added.
- [THIRD-PARTY](THIRD-PARTY) is the list and registration rules for third-party components actually distributed with artifacts.

To the extent required by applicable law, unless otherwise agreed in writing, all contributions are provided "AS IS", without any express or implied warranties.