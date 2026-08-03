const form = document.getElementById("admin-login-form");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const errorBox = document.getElementById("admin-error");
const submitBtn = document.getElementById("submit-btn");
const togglePass = document.getElementById("toggle-pass");

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

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
    showError("Enter both the admin email and password.");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Signing in…";

  try {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showError(data.error || `Something went wrong (${res.status}).`);
      return;
    }
    window.location.href = "/admin.html";
  } catch (err) {
    showError("Network error — is the server running?");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Sign in to console";
  }
});

// Already signed in as admin? Skip straight to the dashboard.
(async () => {
  try {
    const res = await fetch("/api/admin/me");
    if (res.ok) window.location.href = "/admin.html";
  } catch {
    /* server offline — let the form handle it */
  }
})();
