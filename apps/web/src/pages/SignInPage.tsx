import { useState } from "react";
import { useAuth } from "../auth/AuthContext";

export function SignInPage() {
  const { signIn } = useAuth();
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn(): Promise<void> {
    setError(null);
    try {
      await signIn();
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : "Sign-in could not be started.");
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-panel">
        <span className="brand-mark" aria-hidden="true">IL</span>
        <h1>Sign in to InfraLens</h1>
        <p>Use your invited account to continue.</p>
        <button className="primary-button" onClick={() => void handleSignIn()} type="button">
          Sign in
        </button>
        {error === null ? null : <p className="error-message">{error}</p>}
      </div>
    </main>
  );
}
