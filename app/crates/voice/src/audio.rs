//! From what the browser sends (webm/opus from Chrome and Edge, ogg/opus from Firefox; wav for the acceptance tests)
//! to mono f32 PCM at 16 kHz, what whisper expects. All in Rust: symphonia opens the container, `opus-decoder`
//! decodes Opus (symphonia doesn't).

use mango_common::tr;
use std::f64::consts::PI;
use std::io::Cursor;
use symphonia::core::codecs::audio::well_known::CODEC_ID_OPUS;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

pub const SAMPLE_RATE: u32 = 16_000;

/// Opus counts the pre-skip in samples at 48 kHz (RFC 7845, §5.1).
const OPUS_RATE: usize = 48_000;
/// The longest Opus frame is 120 ms.
const OPUS_MAX_FRAME: usize = SAMPLE_RATE as usize * 120 / 1000;

/// Decodes any clip among the supported ones. The error is the text for the user.
pub fn decode(bytes: Vec<u8>) -> Result<Vec<f32>, String> {
    let mss = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
    let mut format = symphonia::default::get_probe()
        .probe(&Hint::new(), mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| tr!("formato audio non riconosciuto: {e}", "audio format not recognized: {e}"))?;
    let track = format.default_track(TrackType::Audio).ok_or_else(|| tr!("nel file non c'è una traccia audio", "there is no audio track in the file"))?;
    let track_id = track.id;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| tr!("parametri audio mancanti", "audio parameters missing"))?
        .clone();

    let pcm = if params.codec == CODEC_ID_OPUS {
        let head = params
            .extra_data
            .as_deref()
            .and_then(parse_opus_head)
            .ok_or_else(|| tr!("intestazione Opus mancante o non valida", "Opus header missing or invalid"))?;
        let mut dec = opus_decoder::OpusDecoder::new(SAMPLE_RATE, 1).map_err(|e| tr!("decoder Opus: {e}", "Opus decoder: {e}"))?;
        let mut out = Vec::new();
        let mut frame = vec![0f32; OPUS_MAX_FRAME];
        while let Some(packet) = next_packet(&mut *format, track_id)? {
            let n = dec.decode_float(&packet.data, &mut frame, false).map_err(|e| tr!("pacchetto Opus non valido: {e}", "invalid Opus packet: {e}"))?;
            out.extend_from_slice(&frame[..n]);
        }
        let skip = (head.pre_skip as usize * SAMPLE_RATE as usize / OPUS_RATE).min(out.len());
        out.drain(..skip);
        out
    } else {
        let mut dec = symphonia::default::get_codecs()
            .make_audio_decoder(&params, &AudioDecoderOptions::default())
            .map_err(|e| tr!("codec audio non supportato: {e}", "audio codec not supported: {e}"))?;
        let mut mono = Vec::new();
        let mut rate = params.sample_rate;
        let mut inter: Vec<f32> = Vec::new();
        while let Some(packet) = next_packet(&mut *format, track_id)? {
            let buf = dec.decode(&packet).map_err(|e| tr!("audio danneggiato: {e}", "audio damaged: {e}"))?;
            rate = Some(buf.spec().rate());
            let ch = buf.spec().channels().count().max(1);
            inter.clear();
            buf.copy_to_vec_interleaved::<f32>(&mut inter);
            mono.extend(inter.chunks_exact(ch).map(|f| f.iter().sum::<f32>() / ch as f32));
        }
        resample(&mono, rate.ok_or_else(|| tr!("frequenza di campionamento sconosciuta", "unknown sampling rate"))?)
    };
    if pcm.is_empty() {
        return Err(tr!("l'audio non contiene campioni", "the audio contains no samples"));
    }
    Ok(pcm)
}

fn next_packet(
    format: &mut dyn symphonia::core::formats::FormatReader,
    track_id: u32,
) -> Result<Option<symphonia::core::packet::Packet>, String> {
    loop {
        match format.next_packet() {
            Ok(Some(p)) if p.track_id == track_id => return Ok(Some(p)),
            Ok(Some(_)) => {}
            Ok(None) => return Ok(None),
            // An interrupted MediaRecorder leaves the stream truncated: what is there is used.
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(e) => return Err(tr!("audio danneggiato: {e}", "audio damaged: {e}")),
        }
    }
}

struct OpusHead {
    pre_skip: u16,
}

/// "OpusHead", versione, canali, pre-skip (u16 LE) ...
fn parse_opus_head(extra: &[u8]) -> Option<OpusHead> {
    (extra.len() >= 19 && extra.starts_with(b"OpusHead"))
        .then(|| OpusHead { pre_skip: u16::from_le_bytes([extra[10], extra[11]]) })
}

/// Resampling to 16 kHz with a Hann-windowed sinc; the cutoff is below the destination's Nyquist, so decimating
/// doesn't fold the spectrum.
fn resample(x: &[f32], rate: u32) -> Vec<f32> {
    if rate == SAMPLE_RATE {
        return x.to_vec();
    }
    const ZERO_CROSSINGS: f64 = 16.0;
    let ratio = rate as f64 / SAMPLE_RATE as f64;
    let cutoff = (1.0 / ratio).min(1.0);
    let half = ZERO_CROSSINGS / cutoff;
    let n_out = (x.len() as f64 / ratio) as usize;
    (0..n_out)
        .map(|i| {
            let c = i as f64 * ratio;
            let lo = (c - half).ceil().max(0.0) as usize;
            let hi = ((c + half).floor() as usize).min(x.len().saturating_sub(1));
            let acc: f64 = (lo..=hi)
                .map(|j| {
                    let d = j as f64 - c;
                    let t = d * cutoff;
                    let sinc = if t == 0.0 { 1.0 } else { (PI * t).sin() / (PI * t) };
                    let hann = 0.5 * (1.0 + (PI * d / half).cos());
                    x[j] as f64 * cutoff * sinc * hann
                })
                .sum();
            acc as f32
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, hz: f64, secs: f64) -> Vec<f32> {
        (0..(rate as f64 * secs) as usize).map(|i| (2.0 * PI * hz * i as f64 / rate as f64).sin() as f32).collect()
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
    }

    #[test]
    fn resample_keeps_duration_and_amplitude() {
        let y = resample(&sine(44_100, 440.0, 1.0), 44_100);
        assert!((y.len() as i64 - 16_000).abs() <= 1);
        // without the edges, where the window leaves the signal
        assert!((rms(&y[200..y.len() - 200]) - std::f64::consts::FRAC_1_SQRT_2).abs() < 0.01);
    }

    #[test]
    fn resample_removes_what_exceeds_nyquist() {
        // 12 kHz at 48 kHz would fold to 4 kHz at the output if not filtered
        let y = resample(&sine(48_000, 12_000.0, 1.0), 48_000);
        assert!(rms(&y[200..y.len() - 200]) < 0.01);
    }

    #[test]
    fn wav_pcm16_stereo_becomes_mono_16k() {
        let rate = 22_050u32;
        let n = rate as usize / 2;
        let mut data = Vec::new();
        for i in 0..n {
            let s = ((2.0 * PI * 300.0 * i as f64 / rate as f64).sin() * 8000.0) as i16;
            data.extend_from_slice(&s.to_le_bytes());
            data.extend_from_slice(&s.to_le_bytes());
        }
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&rate.to_le_bytes());
        wav.extend_from_slice(&(rate * 4).to_le_bytes());
        wav.extend_from_slice(&4u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
        wav.extend_from_slice(&data);
        let y = decode(wav).unwrap();
        assert!((y.len() as i64 - 8_000).abs() <= 2, "{}", y.len());
        assert!((rms(&y[200..y.len() - 200]) - 8000.0 / 32768.0 * std::f64::consts::FRAC_1_SQRT_2).abs() < 0.01);
    }

    #[test]
    fn random_bytes_are_an_error() {
        assert!(decode(vec![1, 2, 3, 4, 5, 6, 7, 8]).is_err());
    }

    #[test]
    fn opus_head_is_read() {
        let mut h = b"OpusHead".to_vec();
        h.extend_from_slice(&[1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]);
        assert_eq!(parse_opus_head(&h).unwrap().pre_skip, 312);
        assert!(parse_opus_head(b"OpusTags").is_none());
    }
}
