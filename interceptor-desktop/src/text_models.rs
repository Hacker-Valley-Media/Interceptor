//! Text embeddings inside the provider: all-MiniLM-L6-v2 run on tract, with the
//! uncased BERT WordPiece tokenizer the model was trained with. The sentence vector is the
//! mask-weighted mean of the token vectors, scaled to length one, as sentence-transformers does.
use crate::failure;
use serde_json::Value;
use std::collections::HashMap;
use tract_onnx::prelude::*;
type Result<T>=std::result::Result<T,Value>;
/// The model reads at most 256 tokens; words and short passages need far fewer.
const MAX_TOKENS:usize=128;

pub(crate) struct Vocabulary{ids:HashMap<String,i64>,unknown:i64,start:i64,end:i64}
impl Vocabulary{
    pub(crate) fn new(bytes:&[u8])->Result<Self>{
        let text=std::str::from_utf8(bytes).map_err(|_|failure("invalid_request","embedding vocabulary is not UTF-8"))?;
        let ids:HashMap<String,i64>=text.lines().enumerate().map(|(i,word)|(word.to_owned(),i as i64)).collect();
        let special=|word:&str|ids.get(word).copied().ok_or_else(||failure("invalid_request",format!("embedding vocabulary has no {word}")));
        Ok(Self{unknown:special("[UNK]")?,start:special("[CLS]")?,end:special("[SEP]")?,ids})
    }
    /// Lowercased words with accents removed and punctuation split off.
    fn words(text:&str)->Vec<String>{
        let lowered=text.to_lowercase();let lowered=icu_normalizer::DecomposingNormalizerBorrowed::new_nfd().normalize(&lowered);
        let mut words=vec![String::new()];
        for c in lowered.chars(){
            // ponytail: the combining-mark blocks cover Latin, Greek and Cyrillic accents; use the full Mn category if other scripts need it.
            if c=='\0'||c=='\u{fffd}'||matches!(c as u32,0x300..=0x36f|0x1ab0..=0x1aff|0x1dc0..=0x1dff|0x20d0..=0x20ff|0xfe20..=0xfe2f)||c.is_control()&&!c.is_whitespace(){continue;}
            let alone=c.is_ascii_punctuation()||matches!(c as u32,0x2000..=0x206f|0x3000..=0x303f|0xff00..=0xff0f|0xff1a..=0xff20)||matches!(c as u32,0x4e00..=0x9fff|0x3400..=0x4dbf|0xf900..=0xfaff|0x20000..=0x2a6df);
            if c.is_whitespace()||alone{if !words.last().unwrap().is_empty(){words.push(String::new());}if alone{words.last_mut().unwrap().push(c);words.push(String::new());}}
            else{words.last_mut().unwrap().push(c);}
        }
        words.retain(|w|!w.is_empty());words
    }
    /// Token ids with the start and end markers, longest-match WordPiece.
    pub(crate) fn encode(&self,text:&str)->Vec<i64>{
        let mut ids=vec![self.start];
        'words:for word in Self::words(text){
            let chars:Vec<char>=word.chars().collect();let mut pieces=Vec::new();let mut start=0;
            if chars.len()>100{ids.push(self.unknown);continue;}
            while start<chars.len(){
                let mut end=chars.len();let mut found=None;
                while end>start{
                    let mut piece:String=chars[start..end].iter().collect();if start>0{piece.insert_str(0,"##");}
                    if let Some(id)=self.ids.get(&piece){found=Some(*id);break;}
                    end-=1;
                }
                let Some(id)=found else{ids.push(self.unknown);continue 'words;};
                pieces.push(id);start=end;
            }
            ids.extend(pieces);
        }
        ids.truncate(MAX_TOKENS-1);ids.push(self.end);ids
    }
}

/// One unit-length vector per text.
pub(crate) fn embed(model:&[u8],vocabulary:&Vocabulary,texts:&[&str])->Result<Vec<Vec<f64>>>{
    let rows:Vec<Vec<i64>>=texts.iter().map(|text|vocabulary.encode(text)).collect();
    let length=rows.iter().map(Vec::len).max().unwrap_or(2);
    let bad=|e:TractError|failure("provider_failed",format!("bundled embedding model failed: {e:#}"));
    let(plan,names)=(||->TractResult<_>{
        let mut graph=tract_onnx::onnx().with_ignore_value_info(true).model_for_read(&mut std::io::Cursor::new(model))?;
        let names:Vec<String>=graph.input_outlets()?.iter().map(|o|graph.node(o.node).name.clone()).collect();
        for i in 0..names.len(){graph=graph.with_input_fact(i,i64::fact([1,length]).into())?;}
        Ok((graph.into_optimized()?.into_runnable()?,names))
    })().map_err(|e|failure("unsupported_target",format!("bundled embedding model could not be prepared: {e:#}")))?;
    let mut vectors=Vec::new();
    for ids in rows{
        let mut padded=ids.clone();padded.resize(length,0);
        let mask:Vec<i64>=(0..length).map(|i|i64::from(i<ids.len())).collect();let types=vec![0i64;length];
        let inputs=names.iter().map(|name|Tensor::from_shape(&[1,length],if name.contains("mask"){&mask}else if name.contains("type"){&types}else{&padded}).map(TValue::from)).collect::<TractResult<TVec<_>>>().map_err(bad)?;
        let output=plan.run(inputs).map_err(bad)?;
        let tokens=output[0].cast_to::<f32>().map_err(bad)?;let tokens=tokens.to_plain_array_view::<f32>().map_err(bad)?;
        let shape=tokens.shape().to_vec();
        if shape.len()!=3||shape[1]!=length||shape[2]==0{return Err(failure("provider_failed","bundled embedding model returned an unexpected shape"));}
        let mut vector=vec![0.0f64;shape[2]];
        for(i,value)in tokens.iter().enumerate(){if i/shape[2]<ids.len(){vector[i%shape[2]]+=f64::from(*value);}}
        let norm=vector.iter().map(|n|n*n).sum::<f64>().sqrt();
        if !norm.is_finite()||norm<=f64::EPSILON{return Err(failure("provider_failed","bundled embedding model returned an empty vector"));}
        for n in &mut vector{*n/=norm;}
        vectors.push(vector);
    }
    Ok(vectors)
}
/// Embeddings from the engine bundle. A panic inside the model code becomes a failure reply.
pub(crate) fn bundled(texts:&[&str])->Result<Vec<Vec<f64>>>{
    let(_,model)=crate::native_library::pinned_bytes("INTERCEPTOR_EMBED_MODEL",128*1024*1024)?;
    let(_,vocabulary)=crate::native_library::pinned_bytes("INTERCEPTOR_EMBED_VOCAB",4*1024*1024)?;
    let vocabulary=Vocabulary::new(&vocabulary)?;
    std::panic::catch_unwind(||embed(&model,&vocabulary,texts)).unwrap_or_else(|_|Err(failure("provider_failed","bundled embedding model stopped unexpectedly")))
}

#[cfg(test)]mod tests{
    use super::*;
    fn vocabulary()->Vocabulary{Vocabulary::new("[PAD]\n[UNK]\n[CLS]\n[SEP]\nhello\nworld\n,\n!\ncafe\nun\n##able\n##s\n世\n界".as_bytes()).unwrap()}
    #[test]fn tokenizer_lowercases_strips_accents_and_splits_pieces(){
        let v=vocabulary();
        assert_eq!(Vocabulary::words("Hello, Café!  世界"),["hello",",","cafe","!","世","界"]);
        assert_eq!(v.encode("Hello, WORLD!"),[2,4,6,5,7,3]);
        // "unables" is un + ##able + ##s; a word with no matching piece is one unknown token.
        assert_eq!(v.encode("unables"),[2,9,10,11,3]);assert_eq!(v.encode("hello zzz"),[2,4,1,3]);
        assert_eq!(v.encode(""),[2,3]);assert_eq!(v.encode(&"hello ".repeat(400)).len(),MAX_TOKENS);
        assert!(Vocabulary::new(b"hello\nworld").is_err());
    }
    /// With INTERCEPTOR_TEST_ENGINES set, related words must sit closer than unrelated ones.
    #[test]fn bundled_embeddings_put_related_words_closer(){
        let Ok(engines)=std::env::var("INTERCEPTOR_TEST_ENGINES")else{return;};
        let file=|name:&str|std::fs::read(std::path::Path::new(&engines).join("embed").join(name)).unwrap();
        let vocabulary=Vocabulary::new(&file("vocab.txt")).unwrap();
        let cosine=|a:&[f64],b:&[f64]|a.iter().zip(b).map(|(x,y)|x*y).sum::<f64>();
        for name in std::env::var("INTERCEPTOR_TEST_EMBED_MODELS").unwrap_or_else(|_|"all-MiniLM-L6-v2.onnx".into()).split(','){
            let vectors=embed(&file(name),&vocabulary,&["cat","dog","carburetor","A man is eating food.","A man is eating a piece of bread."]).unwrap();
            assert_eq!(vectors[0].len(),384);assert!((vectors[0].iter().map(|n|n*n).sum::<f64>()-1.0).abs()<1e-6);
            eprintln!("{name}: cat/dog {:.4} cat/carburetor {:.4} sentences {:.4}",cosine(&vectors[0],&vectors[1]),cosine(&vectors[0],&vectors[2]),cosine(&vectors[3],&vectors[4]));
            assert!(cosine(&vectors[0],&vectors[1])>cosine(&vectors[0],&vectors[2])+0.1,"{name}");assert!(cosine(&vectors[3],&vectors[4])>0.6,"{name}");
        }
    }
}
