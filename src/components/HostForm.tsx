// Shared host connection form — single source of truth used by BOTH the
// ServerPanel quick-connect modal and the Settings > SSH manager.
// Keeps field layout, private-key upload and ConnectionConfig mapping in one
// place (component reuse instead of two drifting copies).

import { useState } from "react";
import { ipc } from "../ipc";
import { Icon } from "./Icon";
import type { ConnectionConfig } from "../types";

export interface HostFormValues {
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "publickey";
  /** SSH password (password auth) or key passphrase (publickey auth). */
  password: string;
  keyPath: string;
  keyFileName: string;
  /** Optional group label for the saved-session list. */
  group: string;
}

export const emptyHostForm = (): HostFormValues => ({
  name: "",
  host: "",
  port: 22,
  username: "root",
  authMethod: "password",
  password: "",
  keyPath: "",
  keyFileName: "",
  group: "",
});

/** Build a ConnectionConfig for saveConnection. Pass an existing id to edit. */
export function connFromForm(form: HostFormValues, id: string): ConnectionConfig {
  return {
    id,
    name: form.name || form.host,
    host: form.host,
    port: Number(form.port) || 22,
    username: form.username,
    auth_method: form.authMethod,
    key_path: form.authMethod === "publickey" ? form.keyPath || null : null,
    group: form.group.trim(),
  };
}

/** Prefill the form from a saved connection (edit mode). Secrets stay empty:
 *  they live in the keychain and only change when the user re-types them. */
export function formFromConn(c: ConnectionConfig): HostFormValues {
  return {
    name: c.name === c.host ? "" : c.name,
    host: c.host,
    port: c.port,
    username: c.username,
    authMethod: c.auth_method === "publickey" ? "publickey" : "password",
    password: "",
    keyPath: c.key_path || "",
    keyFileName: "",
    group: c.group || "",
  };
}

/** Private-key file upload hook: writes the key body to the app-private
 *  keys dir and fills keyPath/keyFileName. */
export function useKeyUpload(
  setForm: React.Dispatch<React.SetStateAction<HostFormValues>>,
  setErr?: (msg: string) => void,
) {
  const [keyBusy, setKeyBusy] = useState(false);
  const onKeyFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setKeyBusy(true);
    setErr?.("");
    try {
      const content = await f.text();
      const path = await ipc.saveUploadedKey(`key-${Date.now()}`, content);
      setForm((prev) => ({ ...prev, keyPath: path, keyFileName: f.name }));
    } catch (err) {
      setErr?.(String(err));
    } finally {
      setKeyBusy(false);
      e.target.value = "";
    }
  };
  return { keyBusy, onKeyFile };
}

/** The shared form grid (name/host/port/user/auth + key upload row). */
export function HostFormFields({
  form,
  setForm,
  keyBusy,
  onKeyFile,
}: {
  form: HostFormValues;
  setForm: React.Dispatch<React.SetStateAction<HostFormValues>>;
  keyBusy: boolean;
  onKeyFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="form-grid">
      <label>名称</label>
      <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="可选，默认用主机名" spellCheck={false} />
      <label>主机</label>
      <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="192.168.1.10" spellCheck={false} />
      <label>端口</label>
      <input value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) || 22 })} />
      <label>用户名</label>
      <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} spellCheck={false} />
      <label>分组</label>
      <input value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })} placeholder="可选，如：生产环境" spellCheck={false} />
      <label>认证方式</label>
      <select
        value={form.authMethod}
        onChange={(e) => setForm({ ...form, authMethod: e.target.value as "password" | "publickey" })}
      >
        <option value="password">密码</option>
        <option value="publickey">私钥</option>
      </select>
      {form.authMethod === "password" ? (
        <>
          <label>密码</label>
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="输入覆盖旧密码，留空保持不变（存入系统凭据库）"
          />
        </>
      ) : (
        <>
          <label>私钥文件</label>
          <div className="key-upload">
            <label className={`upload-btn ${keyBusy ? "busy" : ""}`}>
              <Icon name="file" size={13} /> {keyBusy ? "上传中…" : "选择文件上传"}
              <input
                type="file"
                style={{ display: "none" }}
                onChange={onKeyFile}
                accept=".pem,.key,.ppk,id_rsa,id_ed25519,id_ecdsa"
              />
            </label>
            <span className="key-file-name" title={form.keyPath}>
              {form.keyFileName || "未选择（也可手动填路径）"}
            </span>
          </div>
          <label>私钥路径</label>
          <input
            value={form.keyPath}
            onChange={(e) => setForm({ ...form, keyPath: e.target.value })}
            placeholder={"C:\\Users\\you\\.ssh\\id_ed25519"}
            spellCheck={false}
          />
          <label>私钥口令</label>
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="无则留空，存入系统凭据库"
          />
        </>
      )}
    </div>
  );
}
