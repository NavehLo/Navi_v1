import { Volume2, Loader2, StopCircle } from "lucide-react";

interface AIAssistantUIProps {
  isLoading: boolean;
  isSpeaking: boolean;
  currentScript: string | null;
  onStop: () => void;
  onManualTrigger: () => void;
}

export default function AIAssistantUI({ isLoading, isSpeaking, currentScript, onStop, onManualTrigger }: AIAssistantUIProps) {
  if (!isLoading && !currentScript) {
    return (
      <div className="absolute bottom-4 left-4 z-50">
        <button 
          onClick={onManualTrigger}
          className="bg-emerald-500/90 hover:bg-emerald-500 text-white shadow-xl rounded-full px-4 py-2.5 flex items-center gap-2 backdrop-blur-md transition-all border border-emerald-400/30"
        >
          <Volume2 className="w-4 h-4" />
          <span className="text-sm font-bold">הפעל מדריך וירטואלי</span>
        </button>
      </div>
    );
  }

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-[90%] max-w-lg z-50">
      <div className="bg-zinc-900/95 backdrop-blur-xl border border-emerald-500/30 shadow-2xl rounded-3xl p-5 overflow-hidden relative">
        {/* Glow effect */}
        <div className="absolute top-0 left-0 w-full h-1 bg-emerald-500 opacity-50" />
        
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
            {isLoading ? (
              <Loader2 className="w-5 h-5 text-emerald-400 animate-spin" />
            ) : (
              <Volume2 className="w-5 h-5 text-emerald-400 animate-pulse" />
            )}
          </div>
          
          <div className="flex-1 pt-1">
            <h3 className="text-emerald-400 font-bold text-sm uppercase tracking-widest mb-1">מדריך AI</h3>
            <p className="text-white text-sm leading-relaxed" dir="rtl">
              {isLoading ? 'חושב ומנתח את הסביבה...' : currentScript}
            </p>
          </div>

          {!isLoading && isSpeaking && (
            <button 
              onClick={onStop}
              className="text-zinc-500 hover:text-red-400 transition-colors p-1"
            >
              <StopCircle className="w-6 h-6" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
