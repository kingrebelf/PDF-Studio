# Security

PDF Studio processes files locally. Treat PDFs from unknown sources as untrusted and keep the app and your operating system up to date.

Visual signatures are saved in the application profile for reuse; they are not encrypted separately and are not certificate-based digital signatures. Anyone with access to your user profile may be able to access them.

Redaction rasterizes affected pages. It does not guarantee removal of sensitive data from other pages, metadata, attachments, or other document structures. Inspect and independently verify a saved copy before sharing sensitive material.

To report a security concern, use the repository's [security advisory page](https://github.com/kingrebelf/PDF-Studio/security/advisories) if private reporting is available. Avoid posting exploit details or sensitive documents in a public issue.
