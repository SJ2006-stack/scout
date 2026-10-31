import { ChevronRight, LogOut } from "lucide-react";
import { insideNativeApp, openNativePermissions } from "./nativeApp.ts";
import { PairPanel } from "./PairPanel.tsx";
import type { Account } from "./screen.ts";
import { formatPhone, initialOf } from "./uiText.ts";

type SettingsPanelProps = {
  account: Account;
  voiceReplies: boolean;
  onVoiceReplies: (enabled: boolean) => void;
  onSignOut: () => void;
  onToast: (message: string) => void;
};

export function SettingsPanel({ account, voiceReplies, onVoiceReplies, onSignOut, onToast }: SettingsPanelProps) {
  const phone = formatPhone(account.phone);
  return (
    <div className="settings">
      <section className="panel profile">
        <span className="avatar large" aria-hidden="true">{initialOf(account.name, account.email)}</span>
        <div className="profile-text">
          <strong>{account.name ?? "Your account"}</strong>
          {account.email ? <span>{account.email}</span> : null}
          {phone ? <span>{phone}</span> : null}
        </div>
        <button className="ghost-button" type="button" onClick={onSignOut}>
          <LogOut size={16} aria-hidden="true" />
          Sign out
        </button>
      </section>

      <section className="panel">
        <h3>Preferences</h3>
        <div className="setting-row">
          <div>
            <strong id="voice-label">Spoken replies</strong>
            <p>Scout reads its answers aloud.</p>
          </div>
          <button
            className={voiceReplies ? "switch on" : "switch"}
            type="button"
            role="switch"
            aria-checked={voiceReplies}
            aria-labelledby="voice-label"
            onClick={() => onVoiceReplies(!voiceReplies)}
          >
            <span className="switch-knob" />
          </button>
        </div>
        {insideNativeApp() ? (
          <button
            className="setting-row action"
            type="button"
            onClick={() => {
              if (!openNativePermissions()) onToast("Update the Scout app to manage permissions here.");
            }}
          >
            <div>
              <strong>App permissions</strong>
              <p>Microphone, location, camera and notifications.</p>
            </div>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        ) : null}
      </section>

      <section className="panel">
        <h3>Link another device</h3>
        <PairPanel />
      </section>
    </div>
  );
}
