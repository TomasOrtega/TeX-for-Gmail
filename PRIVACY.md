# Privacy

TeX for Gmail does not collect analytics, telemetry, account identifiers,
email content, or LaTeX input. It has no extension-operated server.

LaTeX compilation and PDF-to-PNG conversion run locally in isolated extension
workers using files packaged with the extension. The extension does not make
runtime requests to a TeX service or content-delivery network.

Firefox hosts the renderer in a non-persistent background page. Chrome creates
a packaged offscreen document when rendering is first requested so the
Manifest V3 target can host the compiler workers. The offscreen document has no
visible interface and runs the same local renderer as Firefox.

The extension can run only on `https://mail.google.com/`. It reads the text
you explicitly select or enter for rendering and inserts the generated image
into the active Gmail draft. For accessibility, formulas up to 512 characters
are also used as the image's alternative text. Gmail will process that image,
alternative text, and the rest of the draft under Google's own terms when it
saves or sends the message.

Compilation working files are unlinked after each render. Worker memory stays
local, compiler state is reset before the next compilation, and both rendering
workers are terminated after five idle minutes or when the last connected
Gmail tab goes away. Chrome may keep the empty offscreen extension document
available under browser-managed lifecycle rules after its workers terminate.
The extension does not intentionally persist rendered source, email content,
or generated images.

Questions or suspected privacy issues can be reported through the project's
[security policy](SECURITY.md).
