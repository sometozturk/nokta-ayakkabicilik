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
  if (allowedOrigins.has(origin)) response.set('Access-Control-Allow-Origin', origin);
  response.set('Vary', 'Origin');
  response.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.set('Access-Control-Allow-Headers', 'Content-Type');
};

const isDataImage = value => typeof value === 'string' && /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value);

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
  if (!isDataImage(personImage) || !isDataImage(shoeImage)) {
    return response.status(400).json({error: 'personImage and shoeImage must be base64 data images.'});
  }

  try {
    const selectedShoe = String(shoeTitle || 'selected shoe').replace(/[\r\n]+/g, ' ').slice(0, 160);
    const runResponse = await fetch('https://api.fashn.ai/v1/run', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${fashnApiKey.value()}`,
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
          output_format: 'jpeg',
          return_base64: true
        }
      })
    });
    const runResult = await runResponse.json();
    if (!runResponse.ok || !runResult.id) {
      return response.status(502).json({error: 'FASHN request failed.', providerStatus: runResponse.status});
    }

    for(let attempt = 0; attempt < 30; attempt++){
      await new Promise(resolve => setTimeout(resolve, 3000));
      const statusResponse = await fetch(`https://api.fashn.ai/v1/status/${encodeURIComponent(runResult.id)}`, {
        headers: {'Authorization': `Bearer ${fashnApiKey.value()}`}
      });
      const statusResult = await statusResponse.json();
      if(statusResult.status === 'completed' && statusResult.output?.[0]){
        return response.json({imageUrl: statusResult.output[0]});
      }
      if(statusResult.status === 'failed' || statusResult.error){
        return response.status(502).json({error: 'FASHN try-on failed.', providerStatus: statusResponse.status});
      }
    }
    return response.status(504).json({error: 'FASHN try-on timed out.', providerStatus: 504});
  } catch (error) {
    console.error('FASHN try-on failed', error?.message || 'Unknown provider error');
    const providerStatus = error?.status || error?.response?.status || 500;
    return response.status(502).json({error: 'AI try-on service failed.', providerStatus});
  }
});
