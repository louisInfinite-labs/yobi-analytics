/** The existing OshiYobi Firebase Web App configuration (project "oshiyobi", the existing Web Data Stream). These are public, client-side
 * identifiers that every visitor's browser receives anyway -- not credentials: access is enforced by Firebase/Google, not by hiding them.
 * Only Analytics is used; no other Firebase product is initialised. */
export const firebaseConfig = {
  apiKey: "AIzaSyD18V7kuAP9HTwHdzYJTzm1RsUey05UDAs",
  authDomain: "oshiyobi.firebaseapp.com",
  projectId: "oshiyobi",
  storageBucket: "oshiyobi.firebasestorage.app",
  messagingSenderId: "772545931970",
  appId: "1:772545931970:web:259f37d1198a113fcc295b",
  measurementId: "G-GDLTY485HK",
} as const
