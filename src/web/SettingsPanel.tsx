import { ChevronRight, LogOut } from "lucide-react";
import { Connectors } from "./Connectors.tsx";
import { GoogleLinks } from "./GoogleLinks.tsx";
import { insideNativeApp, openNativePermissions } from "./nativeApp.ts";
import { PairPanel } from "./PairPanel.tsx";
import type { Account } from "./screen.ts";
import { formatPhone, initialOf } from "./uiText.ts";

type SettingsPanelProps = {
  account: Account;
  onSignOut: () => void;
  onToast: (message: string) => void;
};

export function SettingsPanel({ account, onSignOut, onToast }: SettingsPanelProps) {
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

      {insideNativeApp() ? (
        <section className="panel">
          <h3>Preferences</h3>
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
        </section>
      ) : null}

      <section className="panel">
        <h3>Gmail and Drive</h3>
        <p className="connectors-note">Optional. Connecting gives Scout read and write access, kept on this server.</p>
        <GoogleLinks />
      </section>

      <section className="panel">
        <h3>Connectors</h3>
        <Connectors />
      </section>

      <section className="panel">
        <h3>Link another device</h3>
        <PairPanel />
      </section>
    </div>
  );
}
