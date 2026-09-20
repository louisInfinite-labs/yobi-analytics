/** VAPID public key (Roadmap 4.6 Web Push delivery mechanism), used by
 * `subscribeToPush` as the `applicationServerKey`. Not a secret — a VAPID
 * public key is designed to be shared with every subscribing browser, the
 * same way a TLS certificate's public key is; only its matching private
 * key (kept out of this repo — see `.env.example`'s `VAPID_PRIVATE_KEY_PATH`)
 * must never be committed. Generated once via `py_vapid`; regenerating it
 * would invalidate every browser's existing subscription, since a
 * subscription is tied to the specific key pair it was created with. */
export const VAPID_PUBLIC_KEY = "BLAZ0cWlhwGBFR-Q9ofgkDOZ6OgYOe3r6ZlJC_74jS9Pw-OogxAi6nZPRZceIxevx6vvFSlgL6Va6970N13p2oA"
