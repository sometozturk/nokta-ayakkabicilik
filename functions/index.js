const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

const fashnApiKey = defineSecret('FASHN_API_KEY');

const allowedOrigins = new Set([
  'https://www.noktaayakkabicilik.com',
  'https://noktaayakkabicilik.com',
  'http://localhost:3000',
  'http://127.0.0.1:5500'
]);

const sendCors = (request, response) => {
  const origin = request.get('origin');
  const allowedOrigin = origin && (allowedOrigins.has(origin) || /^https?:\/\/(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+)(:\d+)?$/i.test(origin) || /^capacitor:\/\//i.test(origin) || /^file:\/\//i.test(origin) || /^chrome-extension:\/\//i.test(origin));

  response.set('Vary', 'Origin');
  response.set('Access-Control-Allow-Origin', allowedOrigin ? origin : '*');
  response.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
};

const isDataImage = value => {
  if (typeof value !== 'string') return false;
  if (!/^data:image\/(jpeg|jpg|png|webp|heic|heif);base64,[A-Za-z0-9+/=]+$/.test(value)) return false;
  const [, payload] = value.split(',', 2);
  if (!payload || payload.length < 32) return false;
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length < 8) return false;
  if (value.includes('image/png')) return bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  if (value.includes('image/jpeg') || value.includes('image/jpg')) return bytes.subarray(0, 2).toString('hex') === 'ffd8';
  if (value.includes('image/webp')) return bytes.subarray(0, 4).toString('ascii') === 'RIFF';
  if (value.includes('image/heic') || value.includes('image/heif')) return true;
  return true;
};

exports.tryOn = onRequest({
  region: 'us-central1',
  timeoutSeconds: 120,
  memory: '1GiB',
  secrets: [fashnApiKey]
}, async (request, response) => {
  sendCors(request, response);
  if (request.method === 'OPTIONS') return response.status(204).send('');
  if (request.method !== 'POST') return response.status(405).json({error: 'Only POST is supported.'});

  const {personImage, shoeImage, shoeTitle} = request.body || {};
  console.log('[TryOn] Request received', {
    method: request.method,
    origin: request.get('origin'),
    hasPersonImage: !!personImage,
    hasShoeImage: !!shoeImage,
    personLength: typeof personImage === 'string' ? personImage.length : 0,
    shoeLength: typeof shoeImage === 'string' ? shoeImage.length : 0,
    shoeTitle: String(shoeTitle || '').slice(0, 120)
  });
  if (!isDataImage(personImage) || !isDataImage(shoeImage)) {
    console.error('[TryOn] Invalid image payload', {
      personStartsWith: typeof personImage === 'string' ? personImage.slice(0, 40) : null,
      shoeStartsWith: typeof shoeImage === 'string' ? shoeImage.slice(0, 40) : null
    });
    return response.status(400).json({error: 'personImage and shoeImage must be base64 data images.'});
  }

  try {
    const apiKey = fashnApiKey.value();
    if (!apiKey) {
      return response.status(500).json({error: 'FASHN_API_KEY secret is not configured in Firebase.', providerStatus: 500});
    }

    const selectedShoe = String(shoeTitle || 'selected shoe').replace(/[\r\n]+/g, ' ').slice(0, 160);
    const runResponse = await fetch('https://api.fashn.ai/v1/run', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model_name: 'tryon-max',
        inputs: {
          product_image: shoeImage,
          model_image: personImage,
          prompt: `Place the exact selected shoe, ${selectedShoe}, naturally on the person's visible feet. Match the product image precisely, including its silhouette, colorway and details. Estimate the person's foot length and width from the visible feet, ankles, legs and perspective, then scale the shoe to fit the foot naturally. The shoe must sit inside the foot outline, follow the foot angle and perspective, and never look oversized, floating or wider than the foot. Keep both shoes at a consistent realistic scale. Do not replace it with an Air Force 1 or any other shoe. Preserve the person's identity, pose, lighting, shadows and the rest of the outfit.`,
          resolution: '1k',
          generation_mode: 'fast',
          num_images: 1,
          output_format: 'png',
          return_base64: true
        }
      })
    });

    const rawRunText = await runResponse.text();
    let runResult = {};
    try {
      runResult = rawRunText ? JSON.parse(rawRunText) : {};
    } catch (error) {
      runResult = { raw: rawRunText };
    }

    if (!runResponse.ok || !runResult.id) {
      return response.status(502).json({
        error: 'FASHN request failed.',
        providerStatus: runResponse.status,
        providerBody: runResult.raw || runResult
      });
    }

    for(let attempt = 0; attempt < 30; attempt++){
      await new Promise(resolve => setTimeout(resolve, 3000));
      const statusResponse = await fetch(`https://api.fashn.ai/v1/status/${encodeURIComponent(runResult.id)}`, {
        headers: {'Authorization': `Bearer ${apiKey}`}
      });
      const rawStatusText = await statusResponse.text();
      let statusResult = {};
      try {
        statusResult = rawStatusText ? JSON.parse(rawStatusText) : {};
      } catch (error) {
        statusResult = { raw: rawStatusText };
      }

      if(statusResult.status === 'completed' && statusResult.output?.[0]){
        return response.json({imageUrl: statusResult.output[0]});
      }
      if(statusResult.status === 'failed' || statusResult.error){
        return response.status(502).json({
          error: 'FASHN try-on failed.',
          providerStatus: statusResponse.status,
          providerBody: statusResult.raw || statusResult
        });
      }
    }
    return response.status(504).json({error: 'FASHN try-on timed out.', providerStatus: 504});
  } catch (error) {
    console.error('FASHN try-on failed', error?.message || 'Unknown provider error');
    const providerStatus = error?.status || error?.response?.status || 500;
    return response.status(502).json({error: 'AI try-on service failed.', providerStatus, details: error?.message || 'Unknown provider error'});
  }
});
