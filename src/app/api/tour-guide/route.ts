import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const { lat, lon, month } = await request.json();

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    // Provide a mocked response if no API key is provided yet
    if (!OPENAI_API_KEY) {
      console.warn("No OpenAI API Key found. Returning mocked response.");
      return NextResponse.json({
        text: `ברוכים הבאים לנקודת עניין בנ"צ ${lat.toFixed(3)}, ${lon.toFixed(3)}. בחודש ${month} הפריחה כאן בשיאה, אפשר לראות כאן כלניות ונוריות. תהנו מהסיור!`,
      });
    }

    // Example OpenAI completion request
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini', // Fast, cheap model perfect for small generations
        temperature: 0.7,
        messages: [
          {
            role: "system",
            content: "אתה מדריך טיולים ישראלי מנוסה בארץ ישראל. השתמש בוויב חם ומזמין, תהיה קצר וקולע (מקסימום 2-3 משפטים). התייחס לעונת השנה, לפריחה אפשרית, משקעים או היסטוריה הקשורה לקואורדינטות המדויקות המסופקות."
          },
          {
            role: "user",
            content: `המטייל נמצא עכשיו בנ.צ: קו רוחב ${lat}, קו אורך ${lon}. חודש נוכחי: ${month}. הקרא מדריך לנקודה זו.`
          }
        ]
      })
    });

    const data = await response.json();
    
    if (!response.ok) {
        throw new Error(data.error?.message || "Error calling OpenAI API");
    }

    return NextResponse.json({ 
        text: data.choices[0].message.content 
    });

  } catch (error: any) {
    console.error("AI Guide Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
