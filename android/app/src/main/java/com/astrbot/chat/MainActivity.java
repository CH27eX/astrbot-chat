package com.astrbot.chat;

import android.graphics.Rect;
import android.os.Build;
import android.view.View;

import com.getcapacitor.BridgeActivity;

import java.util.Collections;

/**
 * 左边缘右滑呼出设置抽屉，但 Android 10+ 把左边缘留给了系统「返回」手势，
 * 从屏幕最左边起滑的事件根本到不了 WebView。
 *
 * setSystemGestureExclusionRects 允许 App 把一小块区域从系统手势里排除（每个方向最多 200dp），
 * 这里排除左侧 32dp（约等于 CSS 里 .edge-hit 的 26px 感应区 + 一点余量）。
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onStart() {
        super.onStart();
        excludeLeftEdgeGesture();
    }

    private void excludeLeftEdgeGesture() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        final View root = getWindow().getDecorView();
        root.post(() -> {
            int widthPx = (int) (32 * getResources().getDisplayMetrics().density);
            int heightPx = root.getHeight();
            if (widthPx <= 0 || heightPx <= 0) return;
            root.setSystemGestureExclusionRects(
                Collections.singletonList(new Rect(0, 0, widthPx, heightPx)));
        });
    }
}
