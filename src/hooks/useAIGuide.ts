import { useState, useCallback } from "react";
import { Coordinate3D } from "../utils/trailUtils";

export function useAIGuide() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isSynthesizerActive, setIsSynthesizerActive] = useState(false);
  const [currentScript, setCurrentScript] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const requestGuideForPoint = useCallback(async (coord: Coordinate3D, typeName: string) => {
    setIsLoading(true);
    setCurrentScript(null);

    const monthNames = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
    const currentMonth = monthNames[new Date().getMonth()];

    try {
      const response = await fetch('/api/tour-guide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: coord[0],
          lon: coord[1],
          month: currentMonth,
          type: typeName
        })
      });

      const data = await response.json();
      if (data.text) {
        setCurrentScript(data.text);
        speakText(data.text);
      }
    } catch (e) {
      console.error("AI Guide failed:", e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const speakText = (text: string) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel(); // kill existing

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'he-IL';
    utterance.rate = 1.0;

    utterance.onstart = () => {
        setIsSpeaking(true);
        setIsSynthesizerActive(true);
    };
    utterance.onend = () => {
        setIsSpeaking(false);
        setIsSynthesizerActive(false);
    };

    window.speechSynthesis.speak(utterance);
  };

  const stopSpeaking = () => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      setIsSynthesizerActive(false);
    }
  };

  return { requestGuideForPoint, isSpeaking, isLoading, currentScript, stopSpeaking, isSynthesizerActive };
}
