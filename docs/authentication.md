# Authentication and session model

Production uses Google Cloud's authenticated reverse-proxy boundary (Identity-Aware Proxy or an equivalent Cloud Run ingress that emits verified `X-Goog-Authenticated-User-*` headers). The Express API derives `/api/me` from those verified headers and never accepts a browser-supplied user id. Every project, upload, analytics result, and asset route checks the persisted owner id.

For IAP, configure the OAuth consent screen and request `openid`, `email`, and `profile`. YouTube authorization is separate and belongs to the ingestion worker; it requests `youtube.readonly` and `yt-analytics.readonly`. Add the IAP callback generated for the protected application to the Google OAuth client's authorized redirect URIs. For a custom OAuth proxy, configure its exact HTTPS callback, for example `https://dailies.gurlzine.com/oauth2/callback`.

The browser session is the secure, HTTP-only cookie managed by the identity proxy. Dailies does not store passwords or identity tokens in local storage. Signing out redirects to the configured identity-provider logout URL (`VITE_SIGN_OUT_URL`).

Development and production both require the same verified Google identity boundary. The API does not accept a project owner id from the browser and has no fixture, offline, or synthetic identity path.
