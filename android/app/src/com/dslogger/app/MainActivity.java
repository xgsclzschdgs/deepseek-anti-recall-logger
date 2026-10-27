package com.dslogger.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.text.TextUtils;
import android.util.Base64;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.Charset;

/**
 * DeepSeek 文字留痕 · 安卓客户端
 * 内置留痕脚本的 DeepSeek 浏览器：
 *  - 网络层捕获：拦截主文档 HTML，在页面脚本运行前注入网络捕获脚本（SSE 全文截获）
 *  - 页面层捕获：留痕控制台（v1.4）定时注入兜底
 *  - 撤回弹窗/导出/剪贴板桥接
 */
public class MainActivity extends Activity {

    private static final String HOME_URL = "https://chat.deepseek.com/";
    private static final String BRIDGE_NAME = "DSLoggerBridge";

    private WebView webView;
    private ProgressBar progressBar;
    private String loggerJs;
    private String shimJs;
    private String netcapJs;
    private String uaString;
    private ValueCallback<Uri[]> filePathCallback;
    private long lastInjectAt = 0L;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setVisibility(View.GONE);
        FrameLayout.LayoutParams plp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3));
        plp.gravity = Gravity.TOP;
        progressBar.setLayoutParams(plp);

        root.addView(webView);
        root.addView(progressBar);
        setContentView(root);

        loggerJs = readAsset("ds_logger.js");
        shimJs = readAsset("shim.js");
        netcapJs = readAsset("ds_netcap.js");
        uaString = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
                + "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        s.setSupportZoom(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportMultipleWindows(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        }
        CookieManager.getInstance().setAcceptCookie(true);
        // 标准手机 Chrome UA（去掉 WebView 标记，避免站点拒绝）
        s.setUserAgentString(uaString);

        webView.addJavascriptInterface(new Bridge(), BRIDGE_NAME);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl().toString());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(url);
            }

            /** 主文档 HTML 拦截：在 <head> 前注入网络捕获脚本（document-start 等效） */
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                try {
                    Uri u = request.getUrl();
                    String host = u.getHost() == null ? "" : u.getHost();
                    if (request.isForMainFrame() && "GET".equals(request.getMethod())
                            && (host.endsWith("deepseek.com") || host.endsWith("deepseek.ai"))
                            && !TextUtils.isEmpty(netcapJs)) {
                        HttpURLConnection c = (HttpURLConnection) new URL(u.toString()).openConnection();
                        c.setInstanceFollowRedirects(true);
                        c.setConnectTimeout(15000);
                        c.setReadTimeout(30000);
                        for (java.util.Map.Entry<String, String> h : request.getRequestHeaders().entrySet()) {
                            String k = h.getKey();
                            if (k == null) continue;
                            String lk = k.toLowerCase();
                            if (lk.equals("accept-encoding")) { c.setRequestProperty(k, "identity"); continue; }
                            if (lk.equals("cookie") || lk.equals("user-agent")) continue;
                            c.setRequestProperty(k, h.getValue());
                        }
                        String cookie = CookieManager.getInstance().getCookie(u.toString());
                        if (cookie != null) c.setRequestProperty("Cookie", cookie);
                        c.setRequestProperty("User-Agent", uaString);
                        c.connect();
                        int code = c.getResponseCode();
                        if (code != 200) return null;
                        String ct = c.getContentType();
                        if (ct == null) ct = "text/html";
                        if (!ct.contains("html")) return null;
                        InputStream in = c.getInputStream();
                        ByteArrayOutputStream bos = new ByteArrayOutputStream();
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                        in.close();
                        String html = new String(bos.toByteArray(), Charset.forName("UTF-8"));
                        String inject = "<script>" + netcapJs + "</script>";
                        String patched;
                        if (html.contains("<head>")) patched = html.replaceFirst("<head>", "<head>" + inject);
                        else patched = inject + html;
                        return new WebResourceResponse("text/html", "utf-8",
                                new ByteArrayInputStream(patched.getBytes(Charset.forName("UTF-8"))));
                    }
                } catch (Throwable t) {
                    // 任一异常都回退到 WebView 默认加载
                }
                return null;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                progressBar.setVisibility(View.VISIBLE);
                progressBar.setProgress(0);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                progressBar.setVisibility(View.GONE);
                injectAll();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                if (newProgress >= 100) progressBar.setVisibility(View.GONE);
                else progressBar.setVisibility(View.VISIBLE);
            }

            // WebView 默认不弹 JS alert/confirm，必须自己实现，
            // 否则"删除所有留痕"等确认框会静默失效
            @Override
            public boolean onJsAlert(WebView view, String url, String message,
                                     final android.webkit.JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("提示")
                        .setMessage(message)
                        .setCancelable(false)
                        .setPositiveButton("知道了", new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface d, int w) { result.confirm(); }
                        })
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message,
                                       final android.webkit.JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("请确认")
                        .setMessage(message)
                        .setCancelable(false)
                        .setPositiveButton("确定", new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface d, int w) { result.confirm(); }
                        })
                        .setNegativeButton("取消", new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface d, int w) { result.cancel(); }
                        })
                        .show();
                return true;
            }

            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage cm) {
                android.util.Log.d("DSLogger", cm.message() + " @" + cm.lineNumber());
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                filePathCallback = cb;
                try {
                    startActivityForResult(params.createIntent(), 1001);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
            }
        });

        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimeType, long contentLength) {
                if (url != null && url.startsWith("blob:")) return; // shim 已桥接处理
                if (url != null && url.startsWith("data:")) {
                    saveDataUrl(url, guessName(contentDisposition, mimeType));
                    return;
                }
                downloadRemote(url, guessName(contentDisposition, mimeType));
            }
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(HOME_URL);
        }

        // SPA 路由切换不触发 onPageFinished，定时兜底补注入
        webView.postDelayed(injectRunnable, 1500);
    }

    private final Runnable injectRunnable = new Runnable() {
        @Override
        public void run() {
            injectAll();
            webView.postDelayed(this, 2500);
        }
    };

    private void injectAll() {
        long now = System.currentTimeMillis();
        if (now - lastInjectAt < 800) return;
        lastInjectAt = now;
        evalJs(shimJs);
        evalJs(loggerJs);
    }

    private void evalJs(String code) {
        if (webView == null || TextUtils.isEmpty(code)) return;
        try {
            webView.evaluateJavascript(code, null);
        } catch (Exception ignored) {
        }
    }

    private boolean handleUrl(String url) {
        if (url == null) return false;
        if (url.startsWith("http://") || url.startsWith("https://")) {
            String host = Uri.parse(url).getHost();
            if (host != null && (host.endsWith("deepseek.com") || host.endsWith("deepseek.ai"))) {
                return false;
            }
            openExternal(url);
            return true;
        }
        if (url.startsWith("mailto:") || url.startsWith("tel:") || url.startsWith("intent:")) {
            openExternal(url);
            return true;
        }
        return false;
    }

    private void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            toast("无法打开该链接");
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            webView.evaluateJavascript(
                    "(function(){try{var p=document.getElementById('dslg-pop');" +
                    "if(p&&p.style.display==='flex'){var b=document.getElementById('dslg-pop-ok');if(b)b.click();return 'pop';}" +
                    "var d=document.getElementById('dslg-panel');" +
                    "if(d&&d.classList.contains('show')){var x=document.getElementById('dslg-close');if(x)x.click();return 'panel';}" +
                    "}catch(e){}return 'none';})()",
                    new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String v) {
                            boolean handled = v != null && !v.contains("none");
                            if (!handled && webView != null && webView.canGoBack()) {
                                webView.goBack();
                            } else if (!handled) {
                                finish();
                            }
                        }
                    });
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeCallbacks(injectRunnable);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == 1001) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(
                        WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /* ================= 下载 / 保存 ================= */

    private String guessName(String contentDisposition, String mimeType) {
        String name = null;
        if (contentDisposition != null) {
            int i = contentDisposition.indexOf("filename=");
            if (i >= 0) {
                name = contentDisposition.substring(i + 9).replace("\"", "").trim();
                int semi = name.indexOf(';');
                if (semi > 0) name = name.substring(0, semi);
            }
        }
        if (TextUtils.isEmpty(name)) {
            String ext = ".txt";
            if (mimeType != null && mimeType.contains("json")) ext = ".json";
            name = "DeepSeek留痕_" + System.currentTimeMillis() + ext;
        }
        return name;
    }

    private void saveDataUrl(String dataUrl, String name) {
        try {
            int comma = dataUrl.indexOf(',');
            if (comma < 0) return;
            String meta = dataUrl.substring(0, comma);
            String payload = dataUrl.substring(comma + 1);
            byte[] bytes;
            if (meta.contains("base64")) {
                bytes = Base64.decode(payload, Base64.DEFAULT);
            } else {
                bytes = URLDecoder.decode(payload, "UTF-8").getBytes(Charset.forName("UTF-8"));
            }
            writeToDownloads(name, bytes);
        } catch (Exception e) {
            toast("保存失败：" + e.getMessage());
        }
    }

    private void downloadRemote(final String url, final String name) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setInstanceFollowRedirects(true);
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(30000);
                    conn.setRequestProperty("Cookie", CookieManager.getInstance().getCookie(url));
                    conn.connect();
                    InputStream in = conn.getInputStream();
                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                    in.close();
                    writeToDownloads(name, bos.toByteArray());
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() { toast("下载失败：" + e.getMessage()); }
                    });
                }
            }
        }).start();
    }

    private void writeToDownloads(String name, byte[] bytes) {
        try {
            File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) dir = getFilesDir();
            if (!dir.exists()) dir.mkdirs();
            File out = new File(dir, name);
            FileOutputStream fos = new FileOutputStream(out);
            fos.write(bytes);
            fos.close();
            final String path = out.getAbsolutePath();
            runOnUiThread(new Runnable() {
                @Override
                public void run() { toast("已保存到：" + path); }
            });
        } catch (Exception e) {
            final String msg = e.getMessage();
            runOnUiThread(new Runnable() {
                @Override
                public void run() { toast("保存失败：" + msg); }
            });
        }
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    private String readAsset(String name) {
        InputStream in = null;
        try {
            in = getAssets().open(name);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), Charset.forName("UTF-8"));
        } catch (Exception e) {
            return "";
        } finally {
            try { if (in != null) in.close(); } catch (Exception ignored) {}
        }
    }

    /** 供注入脚本调用的原生能力 */
    public class Bridge {
        @JavascriptInterface
        public void saveText(final String name, final String content) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        byte[] bytes = content == null ? new byte[0] : content.getBytes(Charset.forName("UTF-8"));
                        writeToDownloads(name == null ? "留痕.txt" : name, bytes);
                    } catch (Exception e) {
                        toast("保存失败");
                    }
                }
            });
        }

        @JavascriptInterface
        public void copyText(final String text) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        android.content.ClipboardManager cm =
                                (android.content.ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                        cm.setPrimaryClip(android.content.ClipData.newPlainText("留痕", text));
                        toast("已复制到剪贴板");
                    } catch (Exception e) {
                        toast("复制失败");
                    }
                }
            });
        }

        @JavascriptInterface
        public void toastMsg(final String msg) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() { toast(msg); }
            });
        }

        @JavascriptInterface
        public void openUrl(final String url) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() { openExternal(url); }
            });
        }
    }
}
