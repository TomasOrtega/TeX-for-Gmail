# Privacy

TeX for Gmail does not collect analytics, telemetry, account identifiers,
email content, or formula input. It has no extension-operated server.

Formula rendering runs locally in an extension background document using
MathJax code and font data packaged with the extension. The extension does not
send formula source or email content to a rendering service, content-delivery
network, analytics service, or the project maintainers.

Firefox hosts the renderer in a non-persistent background page. Chrome creates
a packaged offscreen document when rendering is first requested so the
Manifest V3 target can use DOM and canvas APIs. The offscreen document has no
visible interface and runs the same local renderer as Firefox.

The extension can run only on `https://mail.google.com/`. It reads the text
inside explicit math delimiters when you click the Gmail compose-toolbar
button, then inserts the generated image into that draft. For accessibility,
the image has generic alternative text. The original delimited source is held
only in the content script's in-memory state for the current compose page so
Backspace, Delete, or double-click can restore it for editing. It is not
embedded in the generated image or recipient HTML. Gmail processes the image,
alternative text, and the rest of the draft under Google's terms when it saves
or sends the message.

Renderer state stays in memory and TeX state is reset between requests. Chrome
closes the offscreen renderer after five idle minutes. Firefox can unload its
non-persistent background page after the last Gmail runtime port disconnects.
The extension does not intentionally persist data outside the Gmail draft.

## Limited Use

The extension uses Gmail data only to provide the user-facing formula
rendering that you request. It does not:

- sell or transfer Gmail data to third parties;
- use Gmail data for advertising, creditworthiness, or lending;
- allow project maintainers or other humans to read Gmail data; or
- use Gmail data for any purpose unrelated to rendering and inserting the
  requested formula.

The only routine disclosure is the user-directed insertion of the generated
image and alternative text into the Gmail draft. TeX for Gmail's use of
information received from Google services conforms to the Chrome Web Store
User Data Policy, including its Limited Use requirements.

Questions or suspected privacy issues can be reported through the project's
[security policy](SECURITY.md).
