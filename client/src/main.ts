import "./styles/index.css";

if (new URLSearchParams(window.location.search).has("paintTest")) {
  void import("./app/paintTestApp.ts");
} else {
  void import("./app/gameApp.ts");
}
