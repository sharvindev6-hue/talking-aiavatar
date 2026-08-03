const form = document.getElementById("auth-form");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const passwordHint = document.getElementById("password-hint");
const errorBox = document.getElementById("auth-error");
const submitBtn = document.getElementById("submit-btn");
const tabLogin = document.getElementById("tab-login");
const tabRegister = document.getElementById("tab-register");
const togglePass = document.getElementById("toggle-pass");

let mode = "login";

// Where to go after a successful sign-in. Only same-origin relative paths
// are honored (e.g. /?next=/some-page).
const nextParam = new URLSearchParams(window.location.search).get("next") || "/";
const redirectTo = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/";

function setMode(next) {
  mode = next;
  const isLogin = mode === "login";

  tabLogin.classList.toggle("active", isLogin);
  tabRegister.classList.toggle("active", !isLogin);
  tabLogin.setAttribute("aria-selected", String(isLogin));
  tabRegister.setAttribute("aria-selected", String(!isLogin));

  submitBtn.textContent = isLogin ? "Sign in" : "Create account";
  passwordInput.setAttribute(
    "autocomplete",
    isLogin ? "current-password" : "new-password"
  );
  passwordHint.style.display = isLogin ? "none" : "";
  errorBox.hidden = true;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

tabLogin.addEventListener("click", () => setMode("login"));
tabRegister.addEventListener("click", () => setMode("register"));

togglePass.addEventListener("click", () => {
  const show = passwordInput.type === "password";
  passwordInput.type = show ? "text" : "password";
  togglePass.classList.toggle("visible", show);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.hidden = true;

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    showError("Please fill in both email and password.");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = mode === "login" ? "Signing in…" : "Creating account…";

  try {
    const res = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showError(data.error || `Something went wrong (${res.status}).`);
      return;
    }

    window.location.href = redirectTo;
  } catch (err) {
    showError("Network error — is the server running?");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = mode === "login" ? "Sign in" : "Create account";
  }
});

// If already logged in, skip straight to the app.
(async () => {
  try {
    const res = await fetch("/api/auth/me");
    if (res.ok) window.location.href = redirectTo;
  } catch {
    /* server offline — let the form handle it */
  }
})();
