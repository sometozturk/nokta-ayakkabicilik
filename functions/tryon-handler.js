const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_PERSON_IMAGE_CHARS = 7 * 1024 * 1024;
const MAX_SHOE_IMAGE_BYTES = 4 * 1024 * 1024;

const allowedOrigins = new Set([
  'https://www.noktaayakkabicilik.com',
  'https://noktaayakkabicilik.com',
  'http://localhost:8000'
]);

const allowedShoeImageHosts = new Set(['cdn.shopier.app']);

const sendCors = (request, response) => {
  const origin = request.get('origin');
  response.set('Vary', 'Origin');
  if (origin && allowedOrigins.has(origin)) {
    response.set('Access-Control-Allow-Origin', origin);
  }
  response.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Device-Id, X-Firebase-AppCheck');
  response.set('Access-Control-Max-Age', '3600');
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
  return true;
};

const validateShoeImageUrl = value => {
  let parsedUrl;
  try {
    parsedUrl = new URL(value);
  } catch (error) {
    return false;
  }
  return parsedUrl.protocol === 'https:' &&
    !parsedUrl.username &&
    !parsedUrl.password &&
    !parsedUrl.port &&
    allowedShoeImageHosts.has(parsedUrl.hostname) &&
    parsedUrl.pathname.startsWith('/pictures_large/noktaayakkabi_');
};

const mimeFromContentType = contentType => {
  const value = String(contentType || '').toLowerCase();
  if (value.includes('png')) return 'image/png';
  if (value.includes('webp')) return 'image/webp';
  return 'image/jpeg';
};

const fetchShoeImageAsDataUri = async (shoeImageUrl, fetchImpl) => {
  if (!validateShoeImageUrl(shoeImageUrl)) {
    throw new Error('Invalid shoe image URL');
  }

  const imageResponse = await fetchImpl(shoeImageUrl, {redirect: 'error', signal: AbortSignal.timeout(10000)});
  const contentType = String(imageResponse.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
  if (!imageResponse.ok || !['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
    throw new Error('Shoe image unavailable');
  }

  const contentLength = Number(imageResponse.headers.get('content-length') || 0);
  if (contentLength > MAX_SHOE_IMAGE_BYTES) {
    throw new Error('Shoe image too large');
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of imageResponse.body) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_SHOE_IMAGE_BYTES) {
      await imageResponse.body.cancel();
      throw new Error('Shoe image too large');
    }
    chunks.push(buffer);
  }

  const buffer = Buffer.concat(chunks);
  if (buffer.length < 8) throw new Error('Shoe image unavailable');
  return `data:${mimeFromContentType(imageResponse.headers.get('content-type'))};base64,${buffer.toString('base64')}`;
};

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const clientIp = request => {
  const forwarded = String(request.get('x-forwarded-for') || '').split(',')[0].trim();
  return forwarded || request.ip || request.socket?.remoteAddress || 'unknown';
};

const isProviderQuotaError = (status, message) => {
  const code = Number(status) || 0;
  const text = String(message || '').toLowerCase();
  return code === 429 ||
    text.includes('resource_exhausted') ||
    text.includes('quota') ||
    text.includes('rate limit') ||
    text.includes('rate_limit');
};

const isPermanentProviderQuota = (status, message) => {
  const code = Number(status) || 0;
  const text = String(message || '').toLowerCase();
  const isHardQuota = text.includes('resource_exhausted') ||
    text.includes('quota exhausted') ||
    text.includes('quota exceeded') ||
    text.includes('capacity exhausted') ||
    text.includes('daily quota exceeded');
  return (code === 429 && isHardQuota) || isHardQuota;
};

const quotaStatus = reason => {
  if (reason === 'GLOBAL_CAP' || reason === 'QUOTA_EXHAUSTED') return 503;
  return 429;
};

const createTryOnHandler = ({
  verifyIdToken,
  verifyAppCheckToken = async () => ({}),
  getAppCheckMode = () => 'off',
  reserveUsage,
  completeUsage = async () => {},
  refundUsage = async () => {},
  markGlobalTotalExhausted = async () => {},
  resolveProduct,
  getApiKey,
  fetchImpl = fetch,
  sleepImpl = sleep,
  logger = console
}) => async (request, response) => {
  sendCors(request, response);
  if (request.method === 'OPTIONS') return response.status(204).send('');
  if (request.method !== 'POST') return response.status(405).json({error: 'Yalnızca POST desteklenir.'});

  const appCheckMode = String(getAppCheckMode() || 'monitor').toLowerCase();
  if (appCheckMode !== 'off') {
    const appCheckToken = request.get('x-firebase-appcheck') || '';
    try {
      if (!appCheckToken) throw new Error('missing App Check token');
      await verifyAppCheckToken(appCheckToken);
    } catch (error) {
      if (appCheckMode === 'enforce') {
        return response.status(401).json({error: 'Geçersiz istemci doğrulaması.'});
      }
      logger.error('[TryOn] App Check rejected', {message: String(error?.message || 'invalid').slice(0, 80)});
    }
  }

  const authorization = request.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) {
    return response.status(401).json({error: 'Oturum gerekli.'});
  }

  let decodedToken;
  try {
    decodedToken = await verifyIdToken(authorization.slice(7));
  } catch (error) {
    return response.status(401).json({error: 'Geçersiz oturum.'});
  }
  const isAnonymous = decodedToken.firebase?.sign_in_provider === 'anonymous';
  if (!decodedToken.email_verified && !isAnonymous) {
    return response.status(403).json({error: 'E-posta doğrulaması gerekli.'});
  }

  const contentLength = Number(request.get('content-length') || 0);
  const body = request.body;
  if (contentLength > MAX_REQUEST_BYTES || !body || typeof body !== 'object' || Array.isArray(body)) {
    return response.status(413).json({error: 'İstek boyutu sınırı aşıldı.'});
  }

  let serializedBody;
  try {
    serializedBody = JSON.stringify(body);
  } catch (error) {
    return response.status(400).json({error: 'İstek biçimi geçersiz.'});
  }
  if (Buffer.byteLength(serializedBody, 'utf8') > MAX_REQUEST_BYTES) {
    return response.status(413).json({error: 'İstek boyutu sınırı aşıldı.'});
  }

  const {personImage, productId} = body;
  const product = resolveProduct(productId);
  if (typeof personImage !== 'string' || personImage.length > MAX_PERSON_IMAGE_CHARS || !isDataImage(personImage)) {
    return response.status(400).json({error: 'Fotoğraf geçersiz veya izin verilen boyutu aşıyor.'});
  }
  if (!product || !validateShoeImageUrl(product.image)) {
    return response.status(400).json({error: 'Ayakkabı görseli geçersiz.'});
  }

  let usageReservation;
  try {
    usageReservation = await reserveUsage({
      uid: decodedToken.uid,
      ip: clientIp(request),
      isAnonymous,
      deviceId: request.get('x-device-id') || ''
    });
  } catch (error) {
    if (error && error.code === 'TRYON_QUOTA_EXCEEDED') {
      const reason = error.reason || 'DAILY_LIMIT';
      return response.status(quotaStatus(reason)).json({error: reason});
    }
    logger.error('[TryOn] Usage quota unavailable', {
      message: error?.message,
      code: error?.code
    });
    return response.status(503).json({error: 'AI servisi şu anda kullanılamıyor.'});
  }

  const refundReservedDailyUsage = async () => {
    try {
      await refundUsage(usageReservation || {});
    } catch (error) {
      logger.error('[TryOn] Daily quota refund failed', {
        message: error?.message || 'Unknown refund error',
        status: error?.status || error?.response?.status || null
      });
    }
  };

  let shoeImage;
  try {
    shoeImage = await fetchShoeImageAsDataUri(product.image, fetchImpl);
  } catch (error) {
    logger.error('[TryOn] Shoe image fetch failed', {message: error?.message});
    await refundReservedDailyUsage();
    return response.status(400).json({error: 'Ayakkabı görseli alınamadı.'});
  }

  const providerDeadline = Date.now() + 100000;
  try {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('AI service unavailable');

    const selectedShoe = String(product.title || 'seçilen ayakkabı')
      .replace(/[^\p{L}\p{N} .\-()]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    const runResponse = await fetchImpl('https://api.fashn.ai/v1/run', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(15000),
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

    const runResult = await runResponse.json().catch(() => ({}));
    if (!runResponse.ok || !runResult.id) {
      const runMessage = typeof runResult.error === 'string'
        ? runResult.error
        : runResult.error?.message || 'FASHN run request failed';
      throw Object.assign(
        new Error(isProviderQuotaError(runResponse.status, runMessage) ? runMessage : 'FASHN run request failed'),
        {status: runResponse.status}
      );
    }

    for (let attempt = 0; attempt < 30; attempt++) {
      const remainingMs = providerDeadline - Date.now();
      if (remainingMs <= 0) break;
      await sleepImpl(Math.min(3000, remainingMs));
      const requestTimeoutMs = Math.min(15000, Math.max(1, providerDeadline - Date.now()));
      const statusResponse = await fetchImpl(`https://api.fashn.ai/v1/status/${encodeURIComponent(runResult.id)}`, {
        headers: {Authorization: `Bearer ${apiKey}`},
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
      const statusResult = await statusResponse.json().catch(() => ({}));
      if (statusResult.status === 'completed' && statusResult.output?.[0]) {
        await completeUsage(usageReservation || {});
        return response.json({imageUrl: statusResult.output[0]});
      }
      if (!statusResponse.ok || statusResult.status === 'failed' || statusResult.error) {
        const providerMessage = typeof statusResult.error === 'string'
          ? statusResult.error
          : statusResult.error?.message || 'FASHN status request failed';
        throw Object.assign(new Error(providerMessage), {status: statusResponse.status});
      }
    }
    await refundReservedDailyUsage();
    return response.status(504).json({error: 'AI işlemi zaman aşımına uğradı.'});
  } catch (error) {
    await refundReservedDailyUsage();
    const providerStatus = error?.status || error?.response?.status || null;
    const providerMessage = String(error?.message || 'Unknown provider error').slice(0, 500);
    logger.error('[TryOn] AI provider request failed', {
      message: providerMessage,
      status: providerStatus
    });
    if (isProviderQuotaError(providerStatus, providerMessage)) {
      if (isPermanentProviderQuota(providerStatus, providerMessage)) {
        try {
          await markGlobalTotalExhausted();
        } catch (quotaErrorValue) {
          logger.error('[TryOn] Global quota mark failed', {message: quotaErrorValue?.message});
        }
      }
      return response.status(503).json({error: 'QUOTA_EXHAUSTED'});
    }
    if (Date.now() >= providerDeadline) {
      return response.status(504).json({error: 'AI işlemi zaman aşımına uğradı.'});
    }
    return response.status(502).json({error: 'AI servisi şu anda yanıt veremiyor.'});
  }
};

module.exports = {createTryOnHandler};