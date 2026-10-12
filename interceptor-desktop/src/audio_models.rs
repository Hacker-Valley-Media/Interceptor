//! Sound classification inside the provider: CED-tiny, 527 AudioSet classes, run on
//! tract. The mel frontend reproduces what sherpa-onnx feeds this model (offline-stream.cc,
//! CEDTag): 16 kHz, 32 ms periodic Hann frames every 10 ms with reflected edges, power
//! spectrum, 64 Kaldi mel bins from 0 to 8000 Hz, then decibels with a 120 dB floor.
use crate::{failure,vision_models::Net};
use serde_json::Value;
type Result<T>=std::result::Result<T,Value>;
pub(crate) const RATE:u32=16000;
const FRAME:usize=512;
const SHIFT:usize=160;
const BINS:usize=64;

/// Mono samples at any rate to 16 kHz, with a Hann-windowed sinc low-pass.
pub(crate) fn resample(input:&[f32],rate:u32)->Vec<f32>{
    if rate==RATE||input.is_empty(){return input.to_vec();}
    let ratio=f64::from(rate)/f64::from(RATE);let cutoff=(1.0/ratio).min(1.0);let half=16.0*ratio.max(1.0);
    (0..(input.len()as f64/ratio)as usize).map(|n|{
        let at=n as f64*ratio;let mut sum=0.0;
        for k in (at-half).ceil().max(0.0)as usize..=((at+half).floor()as usize).min(input.len()-1){
            let x=k as f64-at;let phase=std::f64::consts::PI*x*cutoff;
            sum+=f64::from(input[k])*cutoff*if phase.abs()<1e-9{1.0}else{phase.sin()/phase}*(0.5+0.5*(std::f64::consts::PI*x/half).cos());
        }
        sum as f32
    }).collect()
}
/// In-place radix-2 FFT of FRAME complex values.
fn fft(re:&mut [f32;FRAME],im:&mut [f32;FRAME]){
    let mut j=0;
    for i in 1..FRAME{let mut bit=FRAME>>1;while j&bit!=0{j^=bit;bit>>=1;}j^=bit;if i<j{re.swap(i,j);im.swap(i,j);}}
    let mut len=2;
    while len<=FRAME{
        let angle=-2.0*std::f64::consts::PI/len as f64;
        for start in (0..FRAME).step_by(len){for k in 0..len/2{
            let(sin,cos)=(angle*k as f64).sin_cos();let(a,b)=(start+k,start+k+len/2);
            let(tr,ti)=(re[b]*cos as f32-im[b]*sin as f32,re[b]*sin as f32+im[b]*cos as f32);
            re[b]=re[a]-tr;im[b]=im[a]-ti;re[a]+=tr;im[a]+=ti;
        }}
        len<<=1;
    }
}
/// Kaldi triangular mel filters over the first FRAME/2 FFT bins.
fn filters()->Vec<Vec<(usize,f32)>>{
    let mel=|hz:f32|1127.0*(1.0+hz/700.0).ln();let(low,high)=(mel(0.0),mel(8000.0));let delta=(high-low)/(BINS as f32+1.0);
    (0..BINS).map(|bin|{
        let(left,center,right)=(low+bin as f32*delta,low+(bin as f32+1.0)*delta,low+(bin as f32+2.0)*delta);
        (0..FRAME/2).filter_map(|i|{let m=mel(RATE as f32/FRAME as f32*i as f32);(m>left&&m<right).then(||(i,if m<=center{(m-left)/(center-left)}else{(right-m)/(right-center)}))}).collect()
    }).collect()
}
/// Decibel mel features laid out as the model reads them: BINS rows of `frames` values.
pub(crate) fn features(samples:&[f32])->(Vec<f32>,usize){
    let frames=(samples.len()+SHIFT/2)/SHIFT;let banks=filters();let mut out=vec![0.0f32;BINS*frames];
    let window:Vec<f32>=(0..FRAME).map(|i|(0.5-0.5*(2.0*std::f64::consts::PI*i as f64/FRAME as f64).cos())as f32).collect();
    for frame in 0..frames{
        let start=(frame*SHIFT+SHIFT/2)as i64-(FRAME/2)as i64;let(mut re,mut im)=([0.0f32;FRAME],[0.0f32;FRAME]);
        for(s,value)in re.iter_mut().enumerate(){
            // Reflect past either end, as Kaldi does with snip_edges off.
            let mut at=start+s as i64;while at<0||at>=samples.len()as i64{at=if at<0{-at-1}else{2*samples.len()as i64-1-at};}
            *value=samples[at as usize]*window[s];
        }
        fft(&mut re,&mut im);
        for(bin,bank)in banks.iter().enumerate(){out[bin*frames+frame]=bank.iter().map(|(i,w)|w*(re[*i]*re[*i]+im[*i]*im[*i])).sum();}
    }
    let mut peak=f32::MIN;for n in &mut out{*n=10.0*n.max(1e-10).log10();peak=peak.max(*n);}
    for n in &mut out{*n=n.max(peak-120.0);}
    (out,frames)
}
/// A classifier prepared for one window length.
pub(crate) struct SoundClassifier{net:Net,labels:Vec<String>,frames:usize,samples:usize}
impl SoundClassifier{
    pub(crate) fn new(model:&[u8],labels:&[u8],samples:usize)->Result<Self>{
        let labels:Vec<String>=serde_json::from_slice(labels).map_err(|_|failure("invalid_request","sound labels must be a JSON array of strings"))?;
        if samples<FRAME||labels.is_empty()||labels.iter().any(|s|s.trim().is_empty()||s.contains('\0')||s.len()>512){return Err(failure("invalid_request","sound classifier needs a window and bounded labels"));}
        let frames=(samples+SHIFT/2)/SHIFT;
        Ok(Self{net:Net::new(model,&[1,BINS,frames])?,labels,frames,samples})
    }
    pub(crate) fn labels(&self)->&[String]{&self.labels}
    /// One probability per label for exactly one window of 16 kHz mono; a short window is zero-padded.
    pub(crate) fn scores(&self,window:&[f32])->Result<Vec<f32>>{
        if window.len()>self.samples||window.iter().any(|n|!n.is_finite()){return Err(failure("provider_failed","sound model received invalid PCM"));}
        let mut padded=window.to_vec();padded.resize(self.samples,0.0);
        let(values,frames)=features(&padded);debug_assert_eq!(frames,self.frames);
        let scores=self.net.run(&[1,BINS,self.frames],values)?.into_iter().next().map(|(_,v)|v).unwrap_or_default();
        if scores.len()!=self.labels.len(){return Err(failure("version_mismatch","sound labels do not match the bundled classifier"));}
        Ok(scores)
    }
}

#[cfg(test)]mod tests{
    use super::*;
    fn tone(hz:f64,rate:u32,seconds:f64)->Vec<f32>{(0..(f64::from(rate)*seconds)as usize).map(|n|(2.0*std::f64::consts::PI*hz*n as f64/f64::from(rate)).sin()as f32*0.5).collect()}
    /// The strongest mel bin and the mean level of one tone.
    fn peak_bin(samples:&[f32])->(usize,f32){
        let(values,frames)=features(samples);let means:Vec<f32>=(0..BINS).map(|b|values[b*frames..(b+1)*frames].iter().sum::<f32>()/frames as f32).collect();
        let best=(0..BINS).max_by(|a,b|means[*a].total_cmp(&means[*b])).unwrap();(best,means[best])
    }
    #[test]fn frontend_frames_and_places_tones_on_the_mel_scale(){
        assert_eq!(features(&vec![0.0;32000]).1,200);assert_eq!(features(&vec![0.0;15999]).1,100);
        // Silence stays finite: every value sits on the 120 dB floor below the peak.
        assert!(features(&vec![0.0;1600]).0.iter().all(|n|n.is_finite()));
        let(low,_)=peak_bin(&tone(440.0,16000,1.0));let(high,_)=peak_bin(&tone(4000.0,16000,1.0));assert!(low<high&&high<BINS,"{low} {high}");
        // A filter's weights rise then fall and stay within 0..1.
        assert!(filters().iter().all(|bank|!bank.is_empty()&&bank.iter().all(|(i,w)|*i<FRAME/2&&(0.0..=1.0).contains(w))));
    }
    #[test]fn resampling_keeps_the_pitch_and_removes_what_16khz_cannot_hold(){
        let down=resample(&tone(1000.0,48000,1.0),48000);assert_eq!(down.len(),16000);
        assert_eq!(peak_bin(&down).0,peak_bin(&tone(1000.0,16000,1.0)).0);
        // 12 kHz cannot exist at 16 kHz; it must be filtered out, not folded down to 4 kHz.
        let alias=resample(&tone(12000.0,48000,1.0),48000);let level=(alias.iter().map(|n|f64::from(*n).powi(2)).sum::<f64>()/alias.len()as f64).sqrt();assert!(level<0.01,"{level}");
        assert_eq!(resample(&[0.25,0.5],16000),vec![0.25,0.5]);assert_eq!(peak_bin(&resample(&tone(1000.0,44100,1.0),44100)).0,peak_bin(&tone(1000.0,16000,1.0)).0);
    }
    /// With INTERCEPTOR_TEST_ENGINES and INTERCEPTOR_TEST_FIXTURES set, the sherpa-onnx test
    /// recordings must get the labels sherpa-onnx itself reports for them.
    #[test]fn bundled_classifier_matches_the_reference_tool(){
        let(Ok(engines),Ok(fixtures))=(std::env::var("INTERCEPTOR_TEST_ENGINES"),std::env::var("INTERCEPTOR_TEST_FIXTURES"))else{return;};
        let file=|name:&str|std::fs::read(std::path::Path::new(&engines).join("sounds").join(name)).unwrap();
        // sherpa-onnx 1.13.8, model.int8.onnx: (file, label, probability).
        for(name,label,expected)in[("1.wav","Animal",0.902548),("2.wav","Whistling",0.795274),("3.wav","A capella",0.748184),("4.wav","Speech",0.692929),("5.wav","Finger snapping",0.878829),("6.wav","Baby cry, infant cry",0.504628)]{
            let bytes=std::fs::read(std::path::Path::new(&fixtures).join("sounds").join(name)).unwrap();
            // 16-bit mono PCM in the "data" chunk (the files carry a LIST chunk before it).
            let data=bytes.windows(4).position(|w|w==b"data").unwrap();let size=u32::from_le_bytes(bytes[data+4..data+8].try_into().unwrap())as usize;
            let samples:Vec<f32>=bytes[data+8..data+8+size].chunks_exact(2).map(|b|f32::from(i16::from_le_bytes([b[0],b[1]]))/32768.0).collect();
            let classifier=SoundClassifier::new(&file("ced-tiny.int8.onnx"),&file("audioset-labels.json"),samples.len()).unwrap();
            let scores=classifier.scores(&samples).unwrap();let best=(0..scores.len()).max_by(|a,b|scores[*a].total_cmp(&scores[*b])).unwrap();
            assert_eq!(classifier.labels()[best],label,"{name}");assert!((scores[best]-expected).abs()<0.03,"{name}: {} vs {expected}",scores[best]);
        }
    }
}
