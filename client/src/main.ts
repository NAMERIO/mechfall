import "./styles/index.css";

if (window.location.pathname === "/mapmaker") {
  void import("./app/mapMakerApp.ts");
} else if (new URLSearchParams(window.location.search).has("paintTest")) {
  void import("./app/paintTestApp.ts");
} else {
  void import("./app/gameApp.ts");
}
