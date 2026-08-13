# Authentication and session model

Production uses Google Cloud's authenticated reverse-proxy boundary (Identity-Aware Proxy or an equivalent Cloud Run ingress that emits verified `X-Goog-Authenticated-User-*` headers). The Express API derives `/api/me` from those verified headers and never accepts a browser-supplied user id. Every project, upload, analytics result, and asset route checks the persisted owner id.

For IAP, configure the OAuth consent screen and request `openid`, `email`, and `profile`. YouTube authorization is separate and belongs to the ingestion worker; it requests `youtube.readonly` and `yt-analytics.readonly`. Add the IAP callback generated for the protected application to the Google OAuth client's authorized redirect URIs. For a custom OAuth proxy, configure its exact HTTPS callback, for example `https://dailies.gurlzine.com/oauth2/callback`.

The browser session is the secure, HTTP-only cookie managed by the identity proxy. Dailies does not store passwords or identity tokens in local storage. Signing out redirects to the configured identity-provider logout URL (`VITE_SIGN_OUT_URL`).

Local development has no fake production sign-in. Set `ALLOW_DEV_AUTH=true`, `DEV_AUTH_EMAIL`, and `DEV_AUTH_NAME` only for a non-production API process. `DEV_AUTH_ID` may pin the local session to an existing development owner when rerunning a persisted project. The config refuses the dev identity path when `NODE_ENV=production`. Leave `DAILIES_FIXTURE_MODE=false` to exercise live services locally.
