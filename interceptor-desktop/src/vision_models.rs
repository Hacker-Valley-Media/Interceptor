//! Hand, body, image-class and saliency analysis inside the provider. The models run
//! on tract, a pure-Rust engine, so no vendor library is loaded. Detection decoding follows the
//! Apache-2.0 reference code published beside each OpenCV Zoo model (mp_palmdet.py,
//! mp_persondet.py, mp_handpose.py, mp_pose.py, mobilenet.py); the crop rectangles use the
//! scale and shift values of the MediaPipe graphs the models were trained with.
use crate::failure;
use serde_json::{json,Value};
use tract_onnx::prelude::*;
type Result<T>=std::result::Result<T,Value>;

pub(crate) const HAND_JOINTS:[&str;21]=["wrist","thumbCMC","thumbMP","thumbIP","thumbTip","indexMCP","indexPIP","indexDIP","indexTip","middleMCP","middlePIP","middleDIP","middleTip","ringMCP","ringPIP","ringDIP","ringTip","littleMCP","littlePIP","littleDIP","littleTip"];
pub(crate) const BODY_JOINTS:[&str;33]=["nose","leftEyeInner","leftEye","leftEyeOuter","rightEyeInner","rightEye","rightEyeOuter","leftEar","rightEar","mouthLeft","mouthRight","leftShoulder","rightShoulder","leftElbow","rightElbow","leftWrist","rightWrist","leftPinky","rightPinky","leftIndex","rightIndex","leftThumb","rightThumb","leftHip","rightHip","leftKnee","rightKnee","leftAnkle","rightAnkle","leftHeel","rightHeel","leftFootIndex","rightFootIndex"];

/// Opaque RGB pixels, row-major.
pub(crate) struct Rgb<'a>{pub width:usize,pub height:usize,pub data:&'a [u8]}
impl Rgb<'_>{
    /// Bilinear sample in [0,1] per channel; black outside the image.
    fn sample(&self,x:f32,y:f32)->[f32;3]{
        let(x0,y0)=(x.floor(),y.floor());let(fx,fy)=(x-x0,y-y0);let mut out=[0.0;3];
        for(dx,dy,weight)in[(0,0,(1.0-fx)*(1.0-fy)),(1,0,fx*(1.0-fy)),(0,1,(1.0-fx)*fy),(1,1,fx*fy)]{
            let(px,py)=(x0 as i64+dx,y0 as i64+dy);
            if weight==0.0||px<0||py<0||px>=self.width as i64||py>=self.height as i64{continue;}
            let at=(py as usize*self.width+px as usize)*3;
            for c in 0..3{out[c]+=weight*f32::from(self.data[at+c])/255.0;}
        }
        out
    }
    /// The same, holding the edge pixels at the border: for scaling the whole image.
    fn scaled(&self,x:f32,y:f32)->[f32;3]{self.sample(x.clamp(0.0,(self.width-1)as f32),y.clamp(0.0,(self.height-1)as f32))}
}

/// A loaded model: one f32 input, f32 outputs returned as (shape, values).
pub(crate) struct Net(Box<dyn Fn(Tensor)->TractResult<TVec<TValue>>>);
impl Net{
    pub(crate) fn new(bytes:&[u8],shape:&[usize])->Result<Self>{
        let plan=(||->TractResult<_>{tract_onnx::onnx().with_ignore_value_info(true).model_for_read(&mut std::io::Cursor::new(bytes))?.with_input_fact(0,f32::fact(shape).into())?.into_optimized()?.into_runnable()})()
            .map_err(|e|failure("unsupported_target",format!("bundled model could not be prepared: {e:#}")))?;
        Ok(Self(Box::new(move|input|plan.run(tvec!(input.into())))))
    }
    pub(crate) fn run(&self,shape:&[usize],values:Vec<f32>)->Result<Vec<(Vec<usize>,Vec<f32>)>>{
        let bad=|e:TractError|failure("provider_failed",format!("bundled model inference failed: {e:#}"));
        let input=Tensor::from_shape(shape,&values).map_err(bad)?;
        let mut rows=Vec::new();
        for output in (self.0)(input).map_err(bad)?{
            let values=output.cast_to::<f32>().map_err(bad)?.to_plain_array_view::<f32>().map_err(bad)?.iter().copied().collect::<Vec<_>>();
            if values.iter().any(|n|!n.is_finite()){return Err(failure("provider_failed","bundled model returned a nonfinite value"));}
            rows.push((output.shape().to_vec(),values));
        }
        Ok(rows)
    }
}

/// A square crop of `size` pixels centered on `center`, turned by `theta` (clockwise, radians).
#[derive(Clone,Copy,Debug)]pub(crate) struct Crop{pub center:[f32;2],pub size:f32,pub theta:f32}
impl Crop{
    /// Crop pixel (in an n-pixel crop) to image pixel.
    pub(crate) fn to_image(&self,x:f32,y:f32,n:f32)->[f32;2]{
        let(a,b)=((x/n-0.5)*self.size,(y/n-0.5)*self.size);let(sin,cos)=self.theta.sin_cos();
        [self.center[0]+a*cos-b*sin,self.center[1]+a*sin+b*cos]
    }
    /// n x n x 3 values in [0,1], rows first.
    fn pixels(&self,image:&Rgb,n:usize)->Vec<f32>{
        let mut out=Vec::with_capacity(n*n*3);
        for j in 0..n{for i in 0..n{let p=self.to_image(i as f32+0.5,j as f32+0.5,n as f32);out.extend(image.sample(p[0]-0.5,p[1]-0.5));}}
        out
    }
}
/// Rotation that turns the direction base -> tip upright (MediaPipe DetectionsToRects).
fn upright(base:[f32;2],tip:[f32;2])->f32{
    let radians=std::f32::consts::FRAC_PI_2-(-(tip[1]-base[1])).atan2(tip[0]-base[0]);
    radians-2.0*std::f32::consts::PI*((radians+std::f32::consts::PI)/(2.0*std::f32::consts::PI)).floor()
}

/// The image scaled into an n x n square with black bars, as the detectors expect.
struct Letterbox{pixels:Vec<f32>,scale:f32,pad:[f32;2],inside:[usize;4]}
fn letterbox(image:&Rgb,n:usize)->Letterbox{
    let ratio=(n as f32/image.width as f32).min(n as f32/image.height as f32);
    let(w,h)=((image.width as f32*ratio)as usize,(image.height as f32*ratio)as usize);
    let(left,top)=((n-w.min(n))/2,(n-h.min(n))/2);
    let mut pixels=vec![0.0;n*n*3];
    for j in top..(top+h).min(n){for i in left..(left+w).min(n){
        let rgb=image.scaled((i-left)as f32/ratio+0.5/ratio-0.5,(j-top)as f32/ratio+0.5/ratio-0.5);
        pixels[(j*n+i)*3..(j*n+i)*3+3].copy_from_slice(&rgb);
    }}
    Letterbox{pixels,scale:image.width.max(image.height)as f32,pad:[left as f32/ratio,top as f32/ratio],inside:[left,top,(left+w).min(n),(top+h).min(n)]}
}

/// Anchor centers for a fixed-size SSD head: (stride, anchors per cell) per layer.
pub(crate) fn anchors(input:usize,layers:&[(usize,usize)])->Vec<[f32;2]>{
    let mut out=Vec::new();
    for&(stride,count)in layers{let grid=input.div_ceil(stride);for y in 0..grid{for x in 0..grid{for _ in 0..count{out.push([(x as f32+0.5)/grid as f32,(y as f32+0.5)/grid as f32]);}}}}
    out
}
#[derive(Clone,Debug)]pub(crate) struct Detection{pub score:f32,pub bbox:[f32;4],pub points:Vec<[f32;2]>}
/// Decode an SSD head into image pixels. `boxes` holds cx,cy,w,h then `points` x,y pairs per anchor.
pub(crate) fn decode(boxes:&[f32],scores:&[f32],anchors:&[[f32;2]],points:usize,input:f32,scale:f32,pad:[f32;2],threshold:f32)->Result<Vec<Detection>>{
    let width=4+points*2;
    if scores.len()!=anchors.len()||boxes.len()!=anchors.len()*width{return Err(failure("provider_failed","bundled detector returned an unexpected tensor size"));}
    let mut out=Vec::new();
    for(i,anchor)in anchors.iter().enumerate(){
        let score=1.0/(1.0+(-scores[i].clamp(-100.0,100.0)).exp());if score<threshold{continue;}
        let row=&boxes[i*width..(i+1)*width];
        let place=|x:f32,y:f32|[(x/input+anchor[0])*scale-pad[0],(y/input+anchor[1])*scale-pad[1]];
        let(c,half)=(place(row[0],row[1]),[row[2]/input*scale/2.0,row[3]/input*scale/2.0]);
        out.push(Detection{score,bbox:[c[0]-half[0],c[1]-half[1],c[0]+half[0],c[1]+half[1]],points:(0..points).map(|k|place(row[4+k*2],row[5+k*2])).collect()});
    }
    Ok(out)
}
fn iou(a:&[f32;4],b:&[f32;4])->f32{
    let(w,h)=((a[2].min(b[2])-a[0].max(b[0])).max(0.0),(a[3].min(b[3])-a[1].max(b[1])).max(0.0));
    let union=(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-w*h;if union<=0.0{0.0}else{w*h/union}
}
/// Greedy non-maximum suppression, best score first.
pub(crate) fn suppress(mut rows:Vec<Detection>,overlap:f32,keep:usize)->Vec<Detection>{
    rows.sort_by(|a,b|b.score.total_cmp(&a.score));let mut out:Vec<Detection>=Vec::new();
    for row in rows{if out.len()>=keep{break;}if out.iter().all(|kept|iou(&kept.bbox,&row.bbox)<overlap){out.push(row);}}
    out
}
fn detect(net:&Net,image:&Rgb,input:usize,layers:&[(usize,usize)],points:usize,channels_first:bool,keep:usize)->Result<Vec<Detection>>{
    let boxed=letterbox(image,input);
    let(shape,values)=if channels_first{
        // Person detector: NCHW in [-1,1]; the bars stay at 0 as in the reference code.
        let mut planar=vec![0.0;input*input*3];let[left,top,right,bottom]=boxed.inside;
        for j in top..bottom{for i in left..right{for c in 0..3{planar[c*input*input+j*input+i]=(boxed.pixels[(j*input+i)*3+c]-0.5)*2.0;}}}
        (vec![1,3,input,input],planar)
    }else{(vec![1,input,input,3],boxed.pixels.clone())};
    let outputs=net.run(&shape,values)?;
    let scores=outputs.iter().find(|(s,_)|s.last()==Some(&1)).ok_or_else(||failure("provider_failed","bundled detector has no score output"))?;
    let boxes=outputs.iter().find(|(s,_)|s.last()==Some(&(4+points*2))).ok_or_else(||failure("provider_failed","bundled detector has no box output"))?;
    Ok(suppress(decode(&boxes.1,&scores.1,&anchors(input,layers),points,input as f32,boxed.scale,boxed.pad,0.5)?,0.3,keep))
}
fn joint(point:[f32;2],image:&Rgb,confidence:Option<f32>)->Option<Value>{
    let(x,y)=(point[0]/image.width as f32,1.0-point[1]/image.height as f32);
    if !(0.0..=1.0).contains(&x)||!(0.0..=1.0).contains(&y)||confidence.is_some_and(|c|c<=0.3){return None;}
    Some(json!({"x":x,"y":y,"confidence":confidence}))
}

/// Up to two hands. The landmark model gives no per-joint score, so joint confidence is null.
pub(crate) fn hands(image:&Rgb,palm_model:&[u8],hand_model:&[u8])->Result<Value>{
    let palms=detect(&Net::new(palm_model,&[1,192,192,3])?,image,192,&[(8,2),(16,6)],7,false,2)?;
    let net=if palms.is_empty(){None}else{Some(Net::new(hand_model,&[1,224,224,3])?)};
    let mut rows=Vec::new();
    for palm in &palms{
        // MediaPipe palm-to-hand rectangle: square on the long side, 2.6x, shifted half a box toward the fingers.
        let theta=upright(palm.points[0],palm.points[2]);let(w,h)=(palm.bbox[2]-palm.bbox[0],palm.bbox[3]-palm.bbox[1]);
        let(sin,cos)=theta.sin_cos();let shift=-0.5*h;
        let crop=Crop{center:[(palm.bbox[0]+palm.bbox[2])/2.0-shift*sin,(palm.bbox[1]+palm.bbox[3])/2.0+shift*cos],size:2.6*w.max(h),theta};
        let outputs=net.as_ref().unwrap().run(&[1,224,224,3],crop.pixels(image,224))?;
        if outputs.len()<3||outputs[0].1.len()!=63||outputs[1].1.len()!=1||outputs[2].1.len()!=1{return Err(failure("provider_failed","bundled hand model returned unexpected outputs"));}
        if outputs[1].1[0]<0.5{continue;}
        let mut joints=serde_json::Map::new();
        for(k,name)in HAND_JOINTS.iter().enumerate(){if let Some(value)=joint(crop.to_image(outputs[0].1[k*3],outputs[0].1[k*3+1],224.0),image,None){joints.insert((*name).into(),value);}}
        // Output 2 runs from 0 (left hand) to 1 (right hand). MediaPipe's left_hands.jpg, a plain photo of
        // two left hands, scores below 0.5, so no mirror correction is applied.
        rows.push(json!({"joints":joints,"chirality":if outputs[2].1[0]>0.5{1}else{-1}}));
    }
    Ok(json!({"count":rows.len(),"hands":rows}))
}

/// At most one body. Joint confidence is the lower of the model's visibility and presence.
pub(crate) fn bodies(image:&Rgb,person_model:&[u8],pose_model:&[u8])->Result<Value>{
    let people=detect(&Net::new(person_model,&[1,3,224,224])?,image,224,&[(8,2),(16,2),(32,6)],4,true,1)?;
    let mut rows=Vec::new();
    if let Some(person)=people.first(){
        // Point 0 is the hip center, point 1 the full-body point; MediaPipe enlarges the square 1.25x.
        let(hip,body)=(person.points[0],person.points[1]);
        let crop=Crop{center:hip,size:2.0*((hip[0]-body[0]).hypot(hip[1]-body[1]))*1.25,theta:upright(hip,body)};
        let outputs=Net::new(pose_model,&[1,256,256,3])?.run(&[1,256,256,3],crop.pixels(image,256))?;
        let landmarks=outputs.iter().find(|(_,v)|v.len()==195).ok_or_else(||failure("provider_failed","bundled pose model has no landmark output"))?;
        let score=outputs.iter().find(|(_,v)|v.len()==1).ok_or_else(||failure("provider_failed","bundled pose model has no score output"))?;
        if score.1[0]>=0.5{
            let sigmoid=|n:f32|1.0/(1.0+(-n.clamp(-100.0,100.0)).exp());
            let mut joints=serde_json::Map::new();
            for(k,name)in BODY_JOINTS.iter().enumerate(){
                let row=&landmarks.1[k*5..k*5+5];
                if let Some(value)=joint(crop.to_image(row[0],row[1],256.0),image,Some(sigmoid(row[3]).min(sigmoid(row[4])))){joints.insert((*name).into(),value);}
            }
            rows.push(json!({"joints":joints}));
        }
    }
    Ok(json!({"count":rows.len(),"bodies":rows}))
}

/// ImageNet labels above 0.1, best first, at most 20.
pub(crate) fn classify(image:&Rgb,model:&[u8],labels:&[u8])->Result<Value>{
    let labels:Vec<String>=serde_json::from_slice(labels).map_err(|_|failure("invalid_request","image-class labels must be a JSON array of strings"))?;
    // Reference preprocessing: scale to 256x256, take the center 224x224, ImageNet mean and deviation.
    let(mean,deviation)=([0.485,0.456,0.406],[0.229,0.224,0.225]);
    let mut planar=vec![0.0;3*224*224];
    for j in 0..224{for i in 0..224{
        let rgb=image.scaled((i as f32+16.5)/256.0*image.width as f32-0.5,(j as f32+16.5)/256.0*image.height as f32-0.5);
        for c in 0..3{planar[c*224*224+j*224+i]=(rgb[c]-mean[c])/deviation[c];}
    }}
    let outputs=Net::new(model,&[1,3,224,224])?.run(&[1,3,224,224],planar)?;
    let scores=&outputs.first().ok_or_else(||failure("provider_failed","bundled classifier returned no output"))?.1;
    if scores.len()!=labels.len(){return Err(failure("version_mismatch","image-class labels do not match the bundled classifier"));}
    let top=scores.iter().copied().fold(f32::MIN,f32::max);let total:f32=scores.iter().map(|n|(n-top).exp()).sum();
    let mut ranked=scores.iter().map(|n|(n-top).exp()/total).enumerate().filter(|(_,p)|*p>0.1).collect::<Vec<_>>();
    ranked.sort_by(|a,b|b.1.total_cmp(&a.1));
    Ok(json!({"classifications":ranked.into_iter().take(20).map(|(i,p)|json!({"label":labels[i],"confidence":p})).collect::<Vec<_>>()}))
}

/// Connected areas of a saliency map (values 0..1, rows first) at or above 0.5, largest first,
/// at most 64. Specks under a quarter percent of the map are dropped. Confidence is the mean
/// map value over the area's own pixels.
pub(crate) fn salient_regions(map:&[f32],w:usize,h:usize)->Vec<Value>{
    let mut seen=vec![false;w*h];let mut regions=Vec::new();let mut stack=Vec::new();
    for start in 0..w*h{
        if seen[start]||map[start]<0.5{continue;}
        let(mut x0,mut y0,mut x1,mut y1,mut area,mut sum)=(w,h,0,0,0usize,0.0f32);stack.push(start);seen[start]=true;
        while let Some(at)=stack.pop(){
            let(x,y)=(at%w,at/w);x0=x0.min(x);y0=y0.min(y);x1=x1.max(x);y1=y1.max(y);area+=1;sum+=map[at];
            for next in [(x>0).then(||at-1),(x+1<w).then(||at+1),(y>0).then(||at-w),(y+1<h).then(||at+w)].into_iter().flatten(){if !seen[next]&&map[next]>=0.5{seen[next]=true;stack.push(next);}}
        }
        if area*400>=w*h{regions.push((area,x0,y0,x1+1,y1+1,(sum/area as f32).clamp(0.0,1.0)));}
    }
    regions.sort_by(|a,b|b.0.cmp(&a.0));regions.truncate(64);
    regions.into_iter().map(|(_,x0,y0,x1,y1,confidence)|json!({"x":x0 as f32/w as f32,"y":(h-y1)as f32/h as f32,"width":(x1-x0)as f32/w as f32,"height":(y1-y0)as f32/h as f32,"confidence":confidence})).collect()
}
/// The things in the picture that stand out, from the U2-Net-p salient-object model. Its first
/// output is a 320 x 320 map of how salient each point is; regions are its connected areas.
pub(crate) fn saliency(image:&Rgb,model:&[u8])->Result<Value>{
    const SIDE:usize=320;let(mean,deviation)=([0.485,0.456,0.406],[0.229,0.224,0.225]);
    let mut planar=vec![0.0;3*SIDE*SIDE];
    for j in 0..SIDE{for i in 0..SIDE{
        let rgb=image.scaled((i as f32+0.5)/SIDE as f32*image.width as f32-0.5,(j as f32+0.5)/SIDE as f32*image.height as f32-0.5);
        for c in 0..3{planar[c*SIDE*SIDE+j*SIDE+i]=(rgb[c]-mean[c])/deviation[c];}
    }}
    let outputs=Net::new(model,&[1,3,SIDE,SIDE])?.run(&[1,3,SIDE,SIDE],planar)?;
    let map=&outputs.first().filter(|(_,values)|values.len()==SIDE*SIDE).ok_or_else(||failure("provider_failed","bundled saliency model returned an unexpected map"))?.1;
    if map.iter().any(|n|!(0.0..=1.0).contains(n)){return Err(failure("provider_failed","bundled saliency model returned values outside 0..1"));}
    Ok(json!({"regions":salient_regions(map,SIDE,SIDE)}))
}

#[cfg(test)]mod tests{
    use super::*;
    fn solid(width:usize,height:usize,fill:impl Fn(usize,usize)->[u8;3])->Vec<u8>{(0..height).flat_map(|y|(0..width).map(move|x|(x,y))).flat_map(|(x,y)|fill(x,y)).collect()}
    #[test]fn anchors_match_the_reference_tables(){
        let palm=anchors(192,&[(8,2),(16,6)]);assert_eq!(palm.len(),2016);
        assert!((palm[0][0]-0.02083333).abs()<1e-6&&(palm[2][0]-0.0625).abs()<1e-6&&(palm[2][1]-0.02083333).abs()<1e-6);
        assert!((palm[1152][0]-0.04166667).abs()<1e-6&&(palm[2015][0]-0.9583333).abs()<1e-6);
        let person=anchors(224,&[(8,2),(16,2),(32,6)]);assert_eq!(person.len(),2254);
        assert!((person[0][0]-0.017857142).abs()<1e-6&&(person[1568][0]-0.03571428).abs()<1e-6&&(person[1960][0]-0.07142857).abs()<1e-6&&(person[2253][1]-0.9285714).abs()<1e-6);
    }
    #[test]fn decoding_maps_through_the_letterbox_and_suppresses_overlaps(){
        // One anchor at the center of a 192 input; the image is 400x200, so 100 px of bar top and bottom.
        let rows=decode(&[0.0,0.0,96.0,48.0,19.2,0.0],&[4.0],&[[0.5,0.5]],1,192.0,400.0,[0.0,100.0],0.5).unwrap();
        assert_eq!(rows.len(),1);assert!((rows[0].bbox[0]-100.0).abs()<1e-3&&(rows[0].bbox[1]-50.0).abs()<1e-3&&(rows[0].bbox[2]-300.0).abs()<1e-3&&(rows[0].bbox[3]-150.0).abs()<1e-3);
        assert!((rows[0].points[0][0]-240.0).abs()<1e-3&&(rows[0].points[0][1]-100.0).abs()<1e-3);
        assert!(decode(&[0.0;6],&[-4.0],&[[0.5,0.5]],1,192.0,400.0,[0.0,100.0],0.5).unwrap().is_empty());
        assert!(decode(&[0.0;5],&[4.0],&[[0.5,0.5]],1,192.0,400.0,[0.0,100.0],0.5).is_err());
        let near=|x:f32,score|Detection{score,bbox:[x,0.0,x+10.0,10.0],points:vec![]};
        let kept=suppress(vec![near(0.0,0.6),near(1.0,0.9),near(40.0,0.7),near(80.0,0.8)],0.3,2);
        assert_eq!(kept.len(),2);assert_eq!(kept[0].score,0.9);assert_eq!(kept[1].score,0.8);
    }
    #[test]fn crops_turn_and_map_back(){
        assert!(upright([10.0,20.0],[10.0,5.0]).abs()<1e-6);
        assert!((upright([10.0,20.0],[30.0,20.0])-std::f32::consts::FRAC_PI_2).abs()<1e-6);
        // An upright crop is a plain window; a quarter turn sends the crop's top edge to the right.
        let crop=Crop{center:[50.0,40.0],size:20.0,theta:0.0};
        assert_eq!(crop.to_image(0.0,0.0,10.0),[40.0,30.0]);assert_eq!(crop.to_image(10.0,10.0,10.0),[60.0,50.0]);
        let turned=Crop{theta:std::f32::consts::FRAC_PI_2,..crop}.to_image(5.0,0.0,10.0);
        assert!((turned[0]-60.0).abs()<1e-4&&(turned[1]-40.0).abs()<1e-4);
        let data=solid(4,4,|x,_|if x<2{[255,0,0]}else{[0,0,255]});let image=Rgb{width:4,height:4,data:&data};
        assert_eq!(image.sample(0.0,0.0),[1.0,0.0,0.0]);assert_eq!(image.sample(3.0,3.0),[0.0,0.0,1.0]);assert_eq!(image.sample(-2.0,0.0),[0.0;3]);
        let boxed=letterbox(&image,8);assert_eq!(boxed.pad,[0.0,0.0]);assert_eq!(boxed.scale,4.0);assert_eq!(&boxed.pixels[0..3],&[1.0,0.0,0.0]);
        assert!(joint([2.0,1.0],&image,None).is_some()&&joint([5.0,1.0],&image,None).is_none()&&joint([2.0,1.0],&image,Some(0.2)).is_none());
        assert_eq!(joint([2.0,1.0],&image,Some(0.9)).unwrap(),json!({"x":0.5,"y":0.75,"confidence":0.9f32}));
    }
    #[test]fn saliency_regions_come_from_the_map(){
        // A 40x20 map with one bright block (x 24..32, y 6..14) and one bright speck.
        let mut map=vec![0.1f32;40*20];for y in 6..14{for x in 24..32{map[y*40+x]=0.9;}}map[0]=0.99;
        let regions=salient_regions(&map,40,20);assert_eq!(regions.len(),1,"{regions:?}");
        for(key,expected)in[("x",0.6),("y",0.3),("width",0.2),("height",0.4),("confidence",0.9)]{assert!((regions[0][key].as_f64().unwrap()-expected).abs()<1e-5,"{key}: {regions:?}");}
        assert!(salient_regions(&vec![0.2;64],8,8).is_empty());
        // Two separate blocks are two regions, larger first.
        for y in 0..4{for x in 0..4{map[y*40+x]=0.8;}}
        let both=salient_regions(&map,40,20);assert_eq!(both.len(),2);assert!((both[0]["width"].as_f64().unwrap()-0.2).abs()<1e-5);
    }
    /// Runs the real models when INTERCEPTOR_TEST_ENGINES names a staged bundle and
    /// INTERCEPTOR_TEST_FIXTURES a folder with MediaPipe's test photos. With
    /// INTERCEPTOR_TEST_OUTPUT set it also writes each photo with the joints drawn on it.
    #[test]fn bundled_models_read_real_photos(){
        let(Ok(engines),Ok(fixtures))=(std::env::var("INTERCEPTOR_TEST_ENGINES"),std::env::var("INTERCEPTOR_TEST_FIXTURES"))else{return;};
        let model=|name:&str|std::fs::read(std::path::Path::new(&engines).join("vision").join(name)).unwrap();
        let photo=|name:&str|image::open(std::path::Path::new(&fixtures).join(name)).unwrap().to_rgb8();
        fn view(p:&image::RgbImage)->Rgb<'_>{Rgb{width:p.width()as usize,height:p.height()as usize,data:p.as_raw()}}
        let draw=|name:&str,pixels:&image::RgbImage,rows:&[Value]|{let Ok(out)=std::env::var("INTERCEPTOR_TEST_OUTPUT")else{return;};
            let mut copy=pixels.clone();let colors=[[255,40,40],[40,255,40]];
            for(n,row)in rows.iter().enumerate(){for joint in row["joints"].as_object().unwrap().values(){
                let(x,y)=((joint["x"].as_f64().unwrap()*f64::from(copy.width()))as i64,((1.0-joint["y"].as_f64().unwrap())*f64::from(copy.height()))as i64);
                let r=(copy.width().max(copy.height())/150).max(2)as i64;
                for dy in -r..=r{for dx in -r..=r{let(px,py)=(x+dx,y+dy);if px>=0&&py>=0&&(px as u32)<copy.width()&&(py as u32)<copy.height(){copy.put_pixel(px as u32,py as u32,image::Rgb(colors[n%2]));}}}
            }}
            copy.save(std::path::Path::new(&out).join(name)).unwrap();
        };
        let burger=photo("burger.jpg");let seen=classify(&view(&burger),&model("image_classification_mobilenetv2_2022apr.onnx"),&model("imagenet-labels.json")).unwrap();
        assert!(seen["classifications"][0]["label"].as_str().unwrap().contains("burger"),"{seen}");
        let mut report=json!({"burger":seen});
        for name in ["left_hands.jpg","right_hands.jpg","thumb_up.jpg"]{
            let hand=photo(name);let seen=hands(&view(&hand),&model("palm_detection_mediapipe_2023feb.onnx"),&model("handpose_estimation_mediapipe_2023feb.onnx")).unwrap();
            assert!(seen["count"].as_u64().unwrap()>=1&&seen["hands"][0]["joints"].as_object().unwrap().len()>=15,"{name}: {seen}");
            let side=if name.starts_with("left"){Some(-1)}else if name.starts_with("right"){Some(1)}else{None};
            if let Some(side)=side{assert!(seen["hands"].as_array().unwrap().iter().all(|h|h["chirality"]==side),"{name}: {seen}");}
            draw(&format!("{name}.png"),&hand,seen["hands"].as_array().unwrap());report[name]=seen;
        }
        let pose=photo("pose.jpg");let seen=bodies(&view(&pose),&model("person_detection_mediapipe_2023mar.onnx"),&model("pose_estimation_mediapipe_2023mar.onnx")).unwrap();
        assert_eq!(seen["count"],1,"{seen}");assert!(seen["bodies"][0]["joints"].as_object().unwrap().contains_key("nose"),"{seen}");
        draw("pose.jpg.png",&pose,seen["bodies"].as_array().unwrap());report["pose.jpg"]=seen;
        // A photo with no person or hand returns nothing instead of failing.
        assert_eq!(bodies(&view(&burger),&model("person_detection_mediapipe_2023mar.onnx"),&model("pose_estimation_mediapipe_2023mar.onnx")).unwrap()["count"],0);
        assert_eq!(hands(&view(&burger),&model("palm_detection_mediapipe_2023feb.onnx"),&model("handpose_estimation_mediapipe_2023feb.onnx")).unwrap()["count"],0);
        // Saliency: the largest region must hold the subject (the burger; the man in the pose photo).
        for name in ["burger.jpg","pose.jpg","cat.jpg"]{
            let picture=photo(name);let seen=saliency(&view(&picture),&model("u2netp.onnx")).unwrap();let regions=seen["regions"].as_array().unwrap().clone();
            let covers=|x:f64,y:f64|regions.iter().any(|r|{let v=|k:&str|r[k].as_f64().unwrap();v("x")<=x&&x<=v("x")+v("width")&&v("y")<=y&&y<=v("y")+v("height")});
            assert!(!regions.is_empty()&&regions.len()<=8,"{name}: {seen}");
            if name=="burger.jpg"{assert!(covers(0.5,0.5),"{name}: {seen}");}
            // The man stands at about x 0.45..0.55; his torso is near (0.5, 0.4) from the bottom.
            if name=="pose.jpg"{assert!(covers(0.5,0.4)&&regions[0]["width"].as_f64().unwrap()<0.9,"{name}: {seen}");}
            if let Ok(out)=std::env::var("INTERCEPTOR_TEST_OUTPUT"){
                let mut copy=picture.clone();let(w,h)=(f64::from(copy.width()),f64::from(copy.height()));
                for r in &regions{let v=|k:&str|r[k].as_f64().unwrap();let(x0,x1,y0,y1)=((v("x")*w)as u32,(((v("x")+v("width"))*w)as u32).min(copy.width()-1),(((1.0-v("y")-v("height"))*h)as u32).min(copy.height()-1),(((1.0-v("y"))*h)as u32).min(copy.height()-1));
                    for x in x0..=x1{for t in 0..3{copy.put_pixel(x,(y0+t).min(copy.height()-1),image::Rgb([255,0,255]));copy.put_pixel(x,y1.saturating_sub(t),image::Rgb([255,0,255]));}}
                    for y in y0..=y1{for t in 0..3{copy.put_pixel((x0+t).min(copy.width()-1),y,image::Rgb([255,0,255]));copy.put_pixel(x1.saturating_sub(t),y,image::Rgb([255,0,255]));}}}
                copy.save(std::path::Path::new(&out).join(format!("saliency-{name}.png"))).unwrap();
            }
            report[format!("saliency-{name}")]=seen;
        }
        if let Ok(out)=std::env::var("INTERCEPTOR_TEST_OUTPUT"){std::fs::write(std::path::Path::new(&out).join("vision-models.json"),serde_json::to_vec_pretty(&report).unwrap()).unwrap();}
    }
}
