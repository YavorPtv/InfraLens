import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { beginSignIn, completeSignIn } from "../auth/authClient";

export function AuthCallbackPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void completeSignIn(window.location.href)
      .then(() => navigate("/", { replace: true }))
      .catch((callbackError: unknown) => {
        if (active) {
          setError(
            callbackError instanceof Error ? callbackError.message : "Sign-in could not be completed."
          );
        }
      });

    return () => {
      active = false;
    };
  }, [navigate]);

  return (
    <main className="auth-page">
      <div className="auth-panel">
        <span className="brand-mark" aria-hidden="true">IL</span>
        <h1>{error === null ? "Completing sign-in" : "Sign-in failed"}</h1>
        {error === null ? <p>Please wait.</p> : <p className="error-message">{error}</p>}
        {error === null ? null : (
          <button className="primary-button" onClick={() => void beginSignIn()} type="button">
            Try again
          </button>
        )}
      </div>
    </main>
  );
}
