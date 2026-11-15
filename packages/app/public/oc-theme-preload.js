;(function () {
  var scheme = localStorage.getItem("opencode-color-scheme") || "system"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.colorScheme = mode
  // The suite's stylesheet takes its theme from here; the page and the browser's bar take their colour from it once it is loaded
  document.documentElement.dataset.mangoTheme = mode
})()
