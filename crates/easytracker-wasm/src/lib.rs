// lib.rs
// EasyTracker WebAssembly 核心：高性能積分圖 NCC 模板匹配引擎
// 使用 Rust 官方標準庫，免外部 crates 依賴，保證離線快速編譯

#[no_mangle]
pub extern "C" fn alloc(size: usize) -> *mut u8 {
    let mut buf = Vec::with_capacity(size);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, size: usize) {
    if !ptr.is_null() && size > 0 {
        unsafe {
            let _ = Vec::from_raw_parts(ptr, 0, size);
        }
    }
}

/// 執行 NCC 模板匹配
/// search_rgba_ptr: 搜尋區域 RGBA 像素指針 (長度 search_w * search_h * 4)
/// tpl_gray_ptr: 模板已預先去均值之灰階 Float32 陣列指針 (長度 tpl_w * tpl_h)
/// out_result_ptr: 輸出 3 個 f32 的緩衝區指針 [best_score, best_x, best_y]
#[no_mangle]
pub extern "C" fn match_ncc(
    search_rgba_ptr: *const u8,
    search_w: u32,
    search_h: u32,
    tpl_gray_ptr: *const f32,
    tpl_w: u32,
    tpl_h: u32,
    tpl_norm: f32,
    out_result_ptr: *mut f32,
) -> i32 {
    if search_rgba_ptr.is_null() || tpl_gray_ptr.is_null() || out_result_ptr.is_null() {
        return -1;
    }
    if search_w < tpl_w || search_h < tpl_h || tpl_w == 0 || tpl_h == 0 {
        return -2;
    }

    let sw = search_w as usize;
    let sh = search_h as usize;
    let tw = tpl_w as usize;
    let th = tpl_h as usize;
    let num_pixels = sw * sh;
    let tpl_count = (tw * th) as f64;

    let rgba_slice = unsafe { core::slice::from_raw_parts(search_rgba_ptr, num_pixels * 4) };
    let tpl_slice = unsafe { core::slice::from_raw_parts(tpl_gray_ptr, tw * th) };

    // 1. 將 RGBA 轉為灰階 Float32 (ITU-R BT.601 標準權重)
    let mut gray = vec![0.0f32; num_pixels];
    for i in 0..num_pixels {
        let idx = i * 4;
        let r = rgba_slice[idx] as f32;
        let g = rgba_slice[idx + 1] as f32;
        let b = rgba_slice[idx + 2] as f32;
        gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }

    // 2. 構建一階積分圖 S 與二階積分圖 S2
    let table_w = sw + 1;
    let table_h = sh + 1;
    let mut s = vec![0.0f64; table_w * table_h];
    let mut s2 = vec![0.0f64; table_w * table_h];

    for y in 0..sh {
        let mut row_sum = 0.0f64;
        let mut row_sum_sq = 0.0f64;
        let in_row = y * sw;
        let out_row = (y + 1) * table_w;
        let prev_out_row = y * table_w;

        for x in 0..sw {
            let val = gray[in_row + x] as f64;
            row_sum += val;
            row_sum_sq += val * val;
            s[out_row + x + 1] = s[prev_out_row + x + 1] + row_sum;
            s2[out_row + x + 1] = s2[prev_out_row + x + 1] + row_sum_sq;
        }
    }

    // 3. 滑動窗口匹配（二階段粗細金字塔）
    let max_offset_x = sw - tw;
    let max_offset_y = sh - th;

    let mut best_score: f32 = -1.0;
    let mut best_x: usize = 0;
    let mut best_y: usize = 0;

    let norm_thresh = if tpl_norm < 1e-5 { 1e-5 } else { tpl_norm };

    let evaluate_at = |x: usize, y: usize| -> f32 {
        let x1 = x;
        let x2 = x + tw;
        let y1 = y;
        let y2 = y + th;

        let sum = s[y2 * table_w + x2] - s[y1 * table_w + x2] - s[y2 * table_w + x1] + s[y1 * table_w + x1];
        let sum_sq = s2[y2 * table_w + x2] - s2[y1 * table_w + x2] - s2[y2 * table_w + x1] + s2[y1 * table_w + x1];

        let variance = sum_sq - (sum * sum) / tpl_count;
        let s_norm = if variance > 0.0 {
            variance.sqrt() as f32
        } else {
            1e-5
        };
        let denom = s_norm * norm_thresh;

        let mut cross = 0.0f32;
        for ty in 0..th {
            let s_row_idx = (y + ty) * sw + x;
            let t_row_idx = ty * tw;
            let s_sub = &gray[s_row_idx..s_row_idx + tw];
            let t_sub = &tpl_slice[t_row_idx..t_row_idx + tw];

            for tx in 0..tw {
                cross += s_sub[tx] * t_sub[tx];
            }
        }
        cross / denom
    };

    // 階段 1：步長 2 快速粗篩（計算量大減 75%）
    let step = 2;
    let mut y = 0;
    while y <= max_offset_y {
        let mut x = 0;
        while x <= max_offset_x {
            let score = evaluate_at(x, y);
            if score > best_score {
                best_score = score;
                best_x = x;
                best_y = y;
            }
            x += step;
        }
        y += step;
    }

    // 階段 2：在粗篩峰值鄰域 ±2 像素內進行精確微調
    let refine_radius = 2;
    let start_x = if best_x >= refine_radius { best_x - refine_radius } else { 0 };
    let end_x = if best_x + refine_radius <= max_offset_x { best_x + refine_radius } else { max_offset_x };
    let start_y = if best_y >= refine_radius { best_y - refine_radius } else { 0 };
    let end_y = if best_y + refine_radius <= max_offset_y { best_y + refine_radius } else { max_offset_y };

    for ry in start_y..=end_y {
        for rx in start_x..=end_x {
            let score = evaluate_at(rx, ry);
            if score > best_score {
                best_score = score;
                best_x = rx;
                best_y = ry;
            }
        }
    }


    // 4. 輸出結果 [score, x, y]
    unsafe {
        *out_result_ptr = best_score;
        *out_result_ptr.add(1) = best_x as f32;
        *out_result_ptr.add(2) = best_y as f32;
    }

    0
}
