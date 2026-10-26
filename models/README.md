# Models

## isnet-general-use-q8.onnx

Background-removal model used by the Garage to turn an automatically found vehicle photo into a
showroom cutout, entirely in the browser (ONNX Runtime Web, in a background worker).

- Model: IS-Net "general use" from *Highly Accurate Dichotomous Image Segmentation*
  (Xuebin Qin et al., https://github.com/xuebinqin/DIS), Apache License 2.0.
- Source file: `isnet-general-use.onnx` from the rembg project's model releases
  (https://github.com/danielgatis/rembg/releases/tag/v0.0.0).
- This copy: weights dynamically quantized to 8-bit (`onnxruntime.quantization.quantize_dynamic`,
  QUInt8), which cuts it from 179 MB to 46 MB with very similar results.

Input `input_image` float32 [1,3,1024,1024], RGB scaled to 0..1 minus 0.5.
Output `output_image` float32 [1,1,1024,1024] mask (min-max normalised before use).

The browser downloads it once, the first time a cutout is made, and keeps it in Cache Storage.
