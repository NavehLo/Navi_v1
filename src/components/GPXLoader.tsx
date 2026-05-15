"use client";

import { useState } from "react";
import { Upload, Loader2 } from "lucide-react";

interface GPXLoaderProps {
  onFileLoad: (file: File) => void;
  error?: string | null;
  loading?: boolean;
}

export default function GPXLoader({ onFileLoad, error, loading }: GPXLoaderProps) {
  const [dragActive, setDragActive] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processFile(file);
      e.target.value = "";
    }
  };

  const processFile = (file: File) => {
    const name = file.name.toLowerCase();
    if (!name.endsWith(".gpx") && !name.endsWith(".kml")) {
      setLocalError("קובץ לא תקין — נא לבחור קובץ .gpx או .kml");
      return;
    }
    setLocalError(null);
    onFileLoad(file);
  };

  const displayError = localError || error;

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onDragEnter={handleDrag}
      onDragLeave={handleDrag}
      onDragOver={handleDrag}
      onDrop={handleDrop}
    >
      <div
        className={`bg-zinc-900 border-2 border-dashed rounded-3xl p-10 flex flex-col items-center justify-center max-w-sm w-full mx-4 transition-colors ${dragActive ? "border-orange-500" : "border-zinc-700"}`}
      >
        {loading ? (
          <Loader2 className="w-12 h-12 text-orange-400 mb-4 animate-spin" />
        ) : (
          <Upload className="w-12 h-12 text-zinc-500 mb-4" />
        )}

        <h2 className="text-xl font-bold text-white mb-2">
          {loading ? "טוען מסלול..." : "לטעון קובץ מסלול"}
        </h2>

        {!loading && (
          <p className="text-zinc-400 text-center text-sm mb-6">
            גרור והשאר כאן קובץ{" "}
            <span className="font-mono text-orange-400">.gpx</span> או{" "}
            <span className="font-mono text-orange-400">.kml</span>, או לחץ כדי לבחור.
          </p>
        )}

        {displayError && (
          <div className="w-full text-red-300 text-sm text-center mb-4 bg-red-900/40 border border-red-700/50 px-3 py-2 rounded-xl">
            {displayError}
          </div>
        )}

        {!loading && (
          /* Transparent input overlaid on visible button — works on all mobile browsers */
          <div className="relative w-full">
            <div className="bg-orange-500 text-white font-medium py-2.5 px-6 rounded-full w-full text-center pointer-events-none select-none">
              בחר קובץ ידנית
            </div>
            <input
              type="file"
              accept=".gpx,.kml,application/gpx+xml,application/vnd.google-earth.kml+xml"
              onChange={handleChange}
              className="absolute inset-0 opacity-0 cursor-pointer"
              style={{ width: "100%", height: "100%", fontSize: "0" }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
