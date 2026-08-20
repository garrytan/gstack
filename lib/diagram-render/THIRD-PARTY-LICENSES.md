# Third-party licenses — diagram-render bundle

`dist/diagram-render.html` bundles the following packages (exact pins in
`package.json`; transitive dependencies resolved via `bun.lock`):

| Package | Version | License | Source |
|---|---|---|---|
| mermaid | 11.12.2 | MIT | https://github.com/mermaid-js/mermaid |
| @excalidraw/excalidraw | 0.18.0 | MIT | https://github.com/excalidraw/excalidraw |
| @excalidraw/mermaid-to-excalidraw | 1.1.2 | MIT | https://github.com/excalidraw/mermaid-to-excalidraw |
| react | 18.3.1 | MIT | https://github.com/facebook/react |
| react-dom | 18.3.1 | MIT | https://github.com/facebook/react |

The bundle also embeds fonts shipped inside @excalidraw/excalidraw
(Excalifont and related faces), licensed under the SIL Open Font License 1.1
per the excalidraw repository.

When bumping a pin, re-verify its license field (`bun pm ls` or the package's
LICENSE file) and update this table in the same commit.
