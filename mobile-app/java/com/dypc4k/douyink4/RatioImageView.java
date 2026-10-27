package com.dypc4k.douyink4;

import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.util.AttributeSet;
import android.widget.ImageView;

/** 按固定宽高比排版的 ImageView（抖音作品封面是 3:4） */
public class RatioImageView extends ImageView {

    private float ratio = 4f / 3f;   // height / width

    public RatioImageView(Context c) { super(c); }

    public RatioImageView(Context c, AttributeSet a) { super(c, a); }

    public void setRatio(float r) { this.ratio = r; requestLayout(); }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        super.onMeasure(widthMeasureSpec, heightMeasureSpec);
        int w = getMeasuredWidth();
        if (w > 0) {
            int h = Math.round(w * ratio);
            setMeasuredDimension(w, h);
        }
    }
}
