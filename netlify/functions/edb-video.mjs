// ExerciseDB V2 proxy — keeps the RapidAPI key server-side (Netlify env var
// RAPIDAPI_KEY). Fetches a FRESH media URL per call: the free plan forbids
// caching and media URLs rotate weekly, so nothing is stored anywhere.
export default async (req) => {
  const id = new URL(req.url).searchParams.get('id') || '';
  if (!/^exr_[A-Za-z0-9]+$/.test(id)) return new Response('bad id', { status: 400 });
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return new Response('proxy not configured', { status: 503 });
  const r = await fetch(
    `https://edb-with-videos-and-images-by-ascendapi.p.rapidapi.com/api/v1/exercises/${id}`,
    { headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': 'edb-with-videos-and-images-by-ascendapi.p.rapidapi.com',
      } }
  );
  if (!r.ok) return new Response('upstream ' + r.status, { status: 502 });
  const j = await r.json();
  const d = j && j.data ? j.data : {};
  return new Response(
    JSON.stringify({ videoUrl: d.videoUrl || null, imageUrl: d.imageUrl || null }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
};
export const config = { path: '/api/edb-video' };
