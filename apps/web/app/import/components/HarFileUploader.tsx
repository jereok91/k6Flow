"use client";

/**
 * File picker of the import screen plus the two messages it can produce: the
 * name of the loaded file with its request count, and the validation error.
 */

import type { ChangeEvent } from "react";

interface HarFileUploaderProps {
  /** Name of the loaded file; `null` until one passes validation. */
  fileName: string | null;
  /** Requests found in the loaded file. */
  totalRequests: number;
  /** Validation message of the last attempt, or `null`. */
  fileError: string | null;
  /** Receives the picked file, or `undefined` when the picker was cleared. */
  onFile: (file: File | undefined) => void;
}

export function HarFileUploader({
  fileName,
  totalRequests,
  fileError,
  onFile,
}: HarFileUploaderProps) {
  // The value is cleared so re-picking the same file after fixing it still fires.
  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = "";
    onFile(file);
  };

  return (
    <section className="card">
      <label className="block text-body-sm text-on-surface-variant mb-space-sm">
        Archivo HAR
      </label>
      <input
        type="file"
        accept=".har,.json,application/json"
        onChange={handleChange}
        className="input"
      />
      {fileName !== null && (
        <p className="mt-space-sm text-body-sm text-on-surface-variant">
          <span className="material-symbols-outlined text-[16px] align-middle mr-space-xs" aria-hidden="true">
            description
          </span>
          {fileName} — {totalRequests} peticiones detectadas
        </p>
      )}
      {fileError !== null && (
        <div className="mt-space-md p-space-md rounded-lg bg-error/10 border border-error/30 text-error text-body-sm">
          <span className="material-symbols-outlined text-[16px] mr-space-xs align-middle" aria-hidden="true">
            error
          </span>
          {fileError}
        </div>
      )}
    </section>
  );
}
