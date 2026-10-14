//! Offline dictation through the recognizer Windows ships (SAPI's in-process recognizer, e.g.
//! "Microsoft Speech Recognizer 8.0" on en-US), used when no whisper.cpp engine is configured.
//! Each three-second microphone window from the speech helper becomes a 16 kHz mono
//! 16-bit WAV in the helper's private scratch folder, read back through ISpStream::BindToFile.
use crate::failure;
use serde_json::Value;
use std::{ffi::c_void,io::Write,path::Path,time::{Duration,Instant}};
use windows::{core::{HSTRING,IUnknown,Interface,PCWSTR,PWSTR},Win32::{Media::Speech::*,System::{Com::*,Registry::*}}};

const SP_GETWHOLEPHRASE:u32=u32::MAX;
const NONE_INSTALLED:&str="no Windows speech recognizer is installed (Settings > Time & language > Speech); or configure the whisper.cpp engine (INTERCEPTOR_WHISPER_CLI)";

/// Windows registers each installed recognizer as a token under this key.
pub(crate) fn installed()->Result<(),String>{
    let mut key=HKEY::default();let mut count=0u32;
    unsafe{
        if RegOpenKeyExW(HKEY_LOCAL_MACHINE,&HSTRING::from(r"SOFTWARE\Microsoft\Speech\Recognizers\Tokens"),Some(0),KEY_READ,&mut key).is_err(){return Err(NONE_INSTALLED.into());}
        let status=RegQueryInfoKeyW(key,None,None,None,Some(&mut count),None,None,None,None,None,None,None);let _=RegCloseKey(key);
        if status.is_err(){return Err(NONE_INSTALLED.into());}
    }
    if count==0{Err(NONE_INSTALLED.into())}else{Ok(())}
}

/// One window's text with a leading space, so consecutive windows join like whisper segments.
pub(crate) fn recognize(root:&Path,pcm:&[f32],channels:u16,rate:u32)->Result<String,Value>{
    let wav=root.join(format!("{}.wav",crate::monitor::identifier()));
    write_wave(&wav,pcm,channels,rate).map_err(|e|failure("provider_failed",e))?;
    let result=unsafe{dictate(&wav)};
    let _=std::fs::remove_file(&wav);
    result.map(|text|if text.is_empty(){text}else{format!(" {text}")})
}

// ponytail: linear downmix and resample with no low-pass filter; dictation tolerates the aliasing.
fn wave_bytes(pcm:&[f32],channels:u16,rate:u32)->Vec<u8>{
    let width=usize::from(channels.max(1));let frames=pcm.len()/width;
    let length=if frames==0||rate==0{0}else{(frames as u64*16_000/u64::from(rate))as usize};
    let mono=|frame:usize|{let frame=frame.min(frames-1);pcm[frame*width..frame*width+width].iter().sum::<f32>()/width as f32};
    let mut data=Vec::with_capacity(length*2);
    for index in 0..length{
        let position=index as f64*f64::from(rate)/16_000.0;let frame=position as usize;let fraction=(position-frame as f64)as f32;
        let sample=mono(frame)*(1.0-fraction)+mono(frame+1)*fraction;
        data.extend(((sample.clamp(-1.0,1.0)*32767.0)as i16).to_le_bytes());
    }
    let mut wave=Vec::with_capacity(44+data.len());
    wave.extend(b"RIFF");wave.extend((36+data.len()as u32).to_le_bytes());wave.extend(b"WAVEfmt ");wave.extend(16u32.to_le_bytes());
    wave.extend(1u16.to_le_bytes());wave.extend(1u16.to_le_bytes());wave.extend(16_000u32.to_le_bytes());wave.extend(32_000u32.to_le_bytes());wave.extend(2u16.to_le_bytes());wave.extend(16u16.to_le_bytes());
    wave.extend(b"data");wave.extend((data.len()as u32).to_le_bytes());wave.extend(data);wave
}
fn write_wave(path:&Path,pcm:&[f32],channels:u16,rate:u32)->std::io::Result<()>{
    let mut file=crate::monitor::private_file(path,true)?;file.write_all(&wave_bytes(pcm,channels,rate))?;file.sync_all()
}

unsafe fn dictate(wav:&Path)->Result<String,Value>{unsafe{
    let sapi=|e:windows::core::Error|failure("provider_failed",format!("Windows speech recognition failed: {e}"));
    let _=CoInitializeEx(None,COINIT_MULTITHREADED);
    let recognizer:ISpRecognizer=CoCreateInstance(&SpInprocRecognizer,None,CLSCTX_INPROC_SERVER).map_err(|e|failure("not_installed",format!("{NONE_INSTALLED}: {e}")))?;
    let stream:ISpStream=CoCreateInstance(&SpStream,None,CLSCTX_INPROC_SERVER).map_err(sapi)?;
    stream.BindToFile(&HSTRING::from(wav.as_os_str()),SPFM_OPEN_READONLY,None,None,0).map_err(sapi)?;
    recognizer.SetInput(&stream,true).map_err(sapi)?;
    let context=recognizer.CreateRecoContext().map_err(sapi)?;
    // SPFEI(): each event bit plus the two reserved check bits.
    let interest=[SPEI_RECOGNITION,SPEI_END_SR_STREAM,SPEI_RESERVED1,SPEI_RESERVED2].iter().fold(0u64,|bits,event|bits|1u64<<event.0);
    context.SetInterest(interest,interest).map_err(sapi)?;context.SetNotifyWin32Event().map_err(sapi)?;
    let grammar=context.CreateGrammar(0).map_err(sapi)?;
    grammar.LoadDictation(PCWSTR::null(),SPLO_STATIC).map_err(sapi)?;grammar.SetDictationState(SPRS_ACTIVE).map_err(sapi)?;
    let deadline=Instant::now()+Duration::from_secs(20);let mut text=String::new();
    loop{
        if Instant::now()>=deadline{return Err(failure("provider_failed","Windows speech recognition did not finish a three-second window within 20 s"));}
        let _=context.WaitForNotifyEvent(250);
        let mut events=[SPEVENT::default();16];let mut fetched=0u32;
        context.GetEvents(16,events.as_mut_ptr(),&mut fetched).map_err(sapi)?;
        let mut ended=false;
        for event in &events[..(fetched as usize).min(16)]{
            let(id,kind,raw)=(event._bitfield&0xffff,(event._bitfield>>16)&0xffff,event.lParam.0 as *mut c_void);
            if id==SPEI_END_SR_STREAM.0{ended=true;}
            // SpClearEvent: tokens and objects are released, pointers and strings freed.
            match kind{
                1|2 if !raw.is_null()=>{let object=IUnknown::from_raw(raw);if id==SPEI_RECOGNITION.0&&let Ok(result)=object.cast::<ISpRecoResult>(){
                    let mut words=PWSTR::null();
                    if result.GetText(SP_GETWHOLEPHRASE,SP_GETWHOLEPHRASE,true,&mut words,None).is_ok()&&!words.is_null(){
                        let phrase=words.to_string().unwrap_or_default();CoTaskMemFree(Some(words.0 as *const c_void));
                        let phrase=phrase.trim();if !phrase.is_empty(){if !text.is_empty(){text.push(' ');}text.push_str(phrase);}
                    }
                }},
                3|4 if !raw.is_null()=>CoTaskMemFree(Some(raw as *const c_void)),
                _=>{},
            }
        }
        if ended{break;}
    }
    Ok(text)
}}

#[cfg(test)]mod tests{use super::*;
    // Opt-in on a Windows host with a recognizer: INTERCEPTOR_TEST_SPEECH_WAV names a 16-bit PCM WAV of
    // spoken English (System.Speech synthesizer); it goes through the same path as a microphone window.
    #[test]#[ignore]fn dictates_a_spoken_wav(){
        let path=std::env::var("INTERCEPTOR_TEST_SPEECH_WAV").expect("INTERCEPTOR_TEST_SPEECH_WAV");let bytes=std::fs::read(path).unwrap();
        let channels=u16::from_le_bytes([bytes[22],bytes[23]]);let rate=u32::from_le_bytes(bytes[24..28].try_into().unwrap());
        let data=bytes.windows(4).position(|w|w==b"data").unwrap()+8;
        let pcm:Vec<f32>=bytes[data..].chunks_exact(2).map(|s|i16::from_le_bytes([s[0],s[1]])as f32/32768.0).collect();
        let root=std::env::temp_dir().join(format!("itc-sapi-{}",std::process::id()));std::fs::create_dir_all(&root).unwrap();
        let text=recognize(&root,&pcm,channels,rate).unwrap();let _=std::fs::remove_dir_all(&root);
        println!("recognized: {text:?}");assert!(text.to_lowercase().contains("fox"),"{text:?}");
    }
    #[test]fn window_becomes_16k_mono_pcm16(){
        let wave=wave_bytes(&[0.5,-0.5,1.0,1.0,0.0,0.0],2,48_000);
        assert_eq!(&wave[..4],b"RIFF");assert_eq!(u32::from_le_bytes(wave[24..28].try_into().unwrap()),16_000);assert_eq!(u16::from_le_bytes(wave[22..24].try_into().unwrap()),1);
        assert_eq!(wave.len(),44+2);assert_eq!(i16::from_le_bytes(wave[44..46].try_into().unwrap()),0);
        assert_eq!(wave_bytes(&[],1,16_000).len(),44);
    }
}
