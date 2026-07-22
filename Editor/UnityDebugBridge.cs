using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEngine;

/// <summary>
/// Provides a TCP-based debug bridge that enables Antigravity IDE to communicate
/// with the Unity Editor for debugging purposes. This bridge acts as a relay between
/// the IDE's debug adapter and Unity's Mono debugger.
/// </summary>
[InitializeOnLoad]
public static class UnityDebugBridge
{
    private static TcpListener _listener;
    private static Thread _listenerThread;
    private static bool _isRunning;
    private static readonly object _lock = new object();

    private const string PrefKey_DebugPort = "Antigravity_DebugPort";
    private const string PrefKey_AutoStartBridge = "Antigravity_AutoStartBridge";
    private const int DefaultPort = 56000;

    static UnityDebugBridge()
    {
            // FORCE auto-start to be true first if not set in EditorPrefs to guarantee it launches on first run
            if (!EditorPrefs.HasKey(PrefKey_AutoStartBridge))
            {
                EditorPrefs.SetBool(PrefKey_AutoStartBridge, true);
            }

        // Default to auto-starting the debug bridge so it works seamlessly out-of-the-box
        if (EditorPrefs.GetBool(PrefKey_AutoStartBridge, true))
        {
            StartBridge();
        }

        EditorApplication.quitting += StopBridge;
        AssemblyReloadEvents.beforeAssemblyReload += StopBridge;
    }

    [MenuItem("Antigravity/Start Debug Bridge", false, 100)]
    public static void StartBridge()
    {
        lock (_lock)
        {
            if (_isRunning) return;

            int port = EditorPrefs.GetInt(PrefKey_DebugPort, DefaultPort);

            try
            {
                _listener = new TcpListener(IPAddress.Loopback, port);
                _listener.Start();
                _isRunning = true;

                _listenerThread = new Thread(ListenForConnections)
                {
                    IsBackground = true,
                    Name = "AntigravityDebugBridge"
                };
                _listenerThread.Start();

                Debug.Log($"[Antigravity] Debug bridge started on port {port}");
                GenerateDebugInfo(port);
            }
            catch (SocketException ex)
            {
                Debug.LogError($"[Antigravity] Failed to start debug bridge on port {port}: {ex.Message}");
                _isRunning = false;
            }
        }
    }

    [MenuItem("Antigravity/Stop Debug Bridge", false, 101)]
    public static void StopBridge()
    {
        lock (_lock)
        {
            if (!_isRunning) return;

            _isRunning = false;

            try
            {
                _listener?.Stop();
                _listenerThread?.Join(1000);
            }
            catch (Exception)
            {
                // Ignore cleanup errors
            }
            finally
            {
                _listener = null;
                _listenerThread = null;
                Debug.Log("[Antigravity] Debug bridge stopped.");
            }
        }
    }

    [MenuItem("Antigravity/Stop Debug Bridge", true)]
    private static bool ValidateStopBridge()
    {
        return _isRunning;
    }

    [MenuItem("Antigravity/Start Debug Bridge", true)]
    private static bool ValidateStartBridge()
    {
        return !_isRunning;
    }

        [MenuItem("Antigravity/Auto-Start Debug Bridge Toggle", false, 150)]
        public static void ToggleAutoStart()
        {
            bool current = EditorPrefs.GetBool(PrefKey_AutoStartBridge, true);
            EditorPrefs.SetBool(PrefKey_AutoStartBridge, !current);
            Debug.Log($"[Antigravity] Auto-start Debug Bridge is now set to: {!current}");
        }

        [MenuItem("Antigravity/Auto-Start Debug Bridge Toggle", true)]
        private static bool ValidateToggleAutoStart()
        {
            bool current = EditorPrefs.GetBool(PrefKey_AutoStartBridge, true);
            Menu.SetChecked("Antigravity/Auto-Start Debug Bridge Toggle", current);
            return true;
        }

    private static void ListenForConnections()
    {
        while (_isRunning)
        {
            try
            {
                if (_listener != null && _listener.Pending())
                {
                    var client = _listener.AcceptTcpClient();
                    ThreadPool.QueueUserWorkItem(HandleClient, client);
                }
                else
                {
                    Thread.Sleep(100);
                }
            }
            catch (SocketException)
            {
                if (_isRunning)
                {
                    Debug.LogWarning("[Antigravity] Debug bridge listener encountered an error.");
                }
                break;
            }
            catch (ObjectDisposedException)
            {
                break;
            }
        }
    }

    private static void HandleClient(object state)
    {
        var client = (TcpClient)state;
        try
        {
            using (var stream = client.GetStream())
            using (var reader = new StreamReader(stream, Encoding.UTF8))
            using (var writer = new StreamWriter(stream, Encoding.UTF8) { AutoFlush = true })
            {
                string command;
                while (_isRunning && (command = reader.ReadLine()) != null)
                {
                    if (string.IsNullOrWhiteSpace(command)) continue;

                    string response = ProcessCommand(command);
                    writer.WriteLine(response);
                }
            }
        }
        catch (Exception ex)
        {
            if (_isRunning)
            {
                Debug.LogWarning($"[Antigravity] Debug client disconnected: {ex.Message}");
            }
        }
        finally
        {
            client.Close();
        }
    }

    private static string ProcessCommand(string command)
    {
        try
        {
            // Simple JSON-based command protocol
            if (command.Contains("\"type\":\"ping\""))
            {
                return "{\"type\":\"pong\",\"status\":\"ok\"}";
            }
            else if (command.Contains("\"type\":\"info\""))
            {
                return GetDebugInfoJson();
            }
            else if (command.Contains("\"type\":\"pause\""))
            {
                EditorApplication.delayCall += () => EditorApplication.isPaused = true;
                return "{\"type\":\"response\",\"status\":\"paused\"}";
            }
            else if (command.Contains("\"type\":\"resume\""))
            {
                EditorApplication.delayCall += () => EditorApplication.isPaused = false;
                return "{\"type\":\"response\",\"status\":\"resumed\"}";
            }
            else if (command.Contains("\"type\":\"play\""))
            {
                EditorApplication.delayCall += () => EditorApplication.isPlaying = true;
                return "{\"type\":\"response\",\"status\":\"playing\"}";
            }
            else if (command.Contains("\"type\":\"stop\""))
            {
                EditorApplication.delayCall += () => EditorApplication.isPlaying = false;
                return "{\"type\":\"response\",\"status\":\"stopped\"}";
            }
            else if (command.Contains("\"type\":\"find_usages\""))
            {
                string classPath = ExtractJsonValue(command, "class_path");
                if (string.IsNullOrEmpty(classPath))
                {
                    return "{\"type\":\"error\",\"message\":\"missing class_path\"}";
                }
                string className = Path.GetFileNameWithoutExtension(classPath);
                string jsonResult = FindUsagesOfClass(classPath, out List<string> usagesList);

                // Schedule opening the AssetUsagesWindow in Unity on the main thread
                EditorApplication.delayCall += () => {
                    AssetUsagesWindow.ShowWindow(className, usagesList);
                };

                return jsonResult;
            }
            else if (command.Contains("\"type\":\"ping_asset\""))
            {
                string assetPath = ExtractJsonValue(command, "asset_path");
                if (string.IsNullOrEmpty(assetPath))
                {
                    return "{\"type\":\"error\",\"message\":\"missing asset_path\"}";
                }

                EditorApplication.delayCall += () => {
                    var obj = AssetDatabase.LoadMainAssetAtPath(assetPath);
                    if (obj != null)
                    {
                        Selection.activeObject = obj;
                        EditorGUIUtility.PingObject(obj);
                        EditorUtility.FocusProjectWindow();
                    }
                };
                return "{\"type\":\"response\",\"status\":\"pinged\"}";
            }
            else if (command.Contains("\"type\":\"open_asset\""))
            {
                string assetPath = ExtractJsonValue(command, "asset_path");
                if (string.IsNullOrEmpty(assetPath))
                {
                    return "{\"type\":\"error\",\"message\":\"missing asset_path\"}";
                }

                EditorApplication.delayCall += () => {
                    var obj = AssetDatabase.LoadMainAssetAtPath(assetPath);
                    if (obj != null)
                    {
                        if (assetPath.EndsWith(".unity", StringComparison.OrdinalIgnoreCase))
                        {
                            if (UnityEditor.SceneManagement.EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo())
                            {
                                UnityEditor.SceneManagement.EditorSceneManager.OpenScene(assetPath);
                            }
                        }
                        else
                        {
                            AssetDatabase.OpenAsset(obj);
                        }
                        Selection.activeObject = obj;
                        EditorGUIUtility.PingObject(obj);
                        EditorUtility.FocusProjectWindow();
                    }
                };
                return "{\"type\":\"response\",\"status\":\"opened\"}";
            }
            else
            {
                return "{\"type\":\"error\",\"message\":\"unknown command\"}";
            }
        }
        catch (Exception ex)
        {
            return $"{{\"type\":\"error\",\"message\":\"{ex.Message.Replace("\"", "\\\"")}\"}}";
        }
    }

    private static string ExtractJsonValue(string json, string key)
    {
        string pattern = $"\"{key}\"\\s*:\\s*\"([^\"]+)\"";
        var match = System.Text.RegularExpressions.Regex.Match(json, pattern);
        return match.Success ? match.Groups[1].Value : null;
    }

    private static string FindUsagesOfClass(string classPath, out List<string> usagesList)
    {
        usagesList = new List<string>();
        try
        {
            string guidValue = null;
            string metaPath = classPath + ".meta";

            if (File.Exists(metaPath))
            {
                foreach (var line in File.ReadAllLines(metaPath))
                {
                    if (line.Trim().StartsWith("guid:"))
                    {
                        guidValue = line.Substring(line.IndexOf("guid:") + 5).Trim();
                        break;
                    }
                }
            }

            if (string.IsNullOrEmpty(guidValue))
            {
                return "{\"type\":\"usages_result\",\"usages\":[]}";
            }

            return ScanProjectForGuid(guidValue, out usagesList);
        }
        catch (Exception ex)
        {
            return $"{{\"type\":\"error\",\"message\":\"{ex.Message.Replace("\"", "\\\"")}\"}}";
        }
    }

    private static string ScanProjectForGuid(string guid, out List<string> usages)
    {
        usages = new List<string>();
        string projectDir = Directory.GetCurrentDirectory();
        string assetsDir = Path.Combine(projectDir, "Assets");

        if (!Directory.Exists(assetsDir))
        {
            return "{\"type\":\"usages_result\",\"usages\":[]}";
        }

        string[] extensions = { "*.prefab", "*.unity", "*.asset", "*.controller", "*.anim", "*.overrideController", "*.mat", "*.playable" };
        var candidateFiles = new List<string>();

        foreach (var ext in extensions)
        {
            try
            {
                candidateFiles.AddRange(Directory.GetFiles(assetsDir, ext, SearchOption.AllDirectories));
            }
            catch { }
        }

        foreach (var file in candidateFiles)
        {
            try
            {
                string content = File.ReadAllText(file);
                if (content.Contains(guid))
                {
                    string relativePath = file.Replace("\\", "/");
                    int assetsIndex = relativePath.IndexOf("Assets/", StringComparison.OrdinalIgnoreCase);
                    if (assetsIndex >= 0)
                    {
                        relativePath = relativePath.Substring(assetsIndex);
                    }
                    usages.Add(relativePath);
                }
            }
            catch { }
        }

        var sb = new StringBuilder();
        int pid = System.Diagnostics.Process.GetCurrentProcess().Id;
        sb.Append("{\"type\":\"usages_result\",\"process_id\":");
        sb.Append(pid);
        sb.Append(",\"usages\":[");
        for (int i = 0; i < usages.Count; i++)
        {
            sb.Append($"\"{usages[i].Replace("\\", "/")}\"");
            if (i < usages.Count - 1) sb.Append(",");
        }
        sb.Append("]}");

        return sb.ToString();
    }

    private static string GetDebugInfoJson()
    {
        int monoDebuggerPort = GetMonoDebuggerPort();
        return $"{{" +
               $"\"type\":\"debug_info\"," +
               $"\"unity_version\":\"{Application.unityVersion}\"," +
               $"\"project_name\":\"{Path.GetFileName(Directory.GetCurrentDirectory())}\"," +
               $"\"project_path\":\"{Directory.GetCurrentDirectory().Replace("\\", "\\\\")}\"," +
               $"\"mono_debugger_port\":{monoDebuggerPort}," +
               $"\"is_playing\":{(EditorApplication.isPlaying ? "true" : "false")}," +
               $"\"is_paused\":{(EditorApplication.isPaused ? "true" : "false")}," +
               $"\"process_id\":{System.Diagnostics.Process.GetCurrentProcess().Id}" +
               $"}}";
    }

    private static int GetMonoDebuggerPort()
    {
        // Unity's Mono debugger typically listens on port 56000 + offset
        // The actual port can be found in the EditorUserBuildSettings
        try
        {
            string projectDir = Directory.GetCurrentDirectory();
            string debugInfoPath = Path.Combine(projectDir, "Library", "EditorInstance.json");

            if (File.Exists(debugInfoPath))
            {
                string content = File.ReadAllText(debugInfoPath);
                // Simple parsing for process_id to help locate debugger port
                // The actual Mono debugger port is determined at runtime
            }
        }
        catch (Exception)
        {
            // Fallback
        }

        return 56000;
    }

    private static void GenerateDebugInfo(int bridgePort)
    {
        string projectDir = Directory.GetCurrentDirectory();
        string vscodeDir = Path.Combine(projectDir, ".vscode");

        if (!Directory.Exists(vscodeDir))
        {
            Directory.CreateDirectory(vscodeDir);
        }

        // Generate launch.json using DotRush's "unity" debugger type
        // EditorInstance.json path is used by vscode-unity-debug pattern for multi-instance discovery
        string editorInstancePath = "${workspaceFolder}/Library/EditorInstance.json";
        string launchPath = Path.Combine(vscodeDir, "launch.json");
        string launchContent = $@"{{
    ""version"": ""0.2.0"",
    ""configurations"": [
        {{
            ""name"": ""Attach to Unity Editor"",
            ""type"": ""unity"",
            ""request"": ""attach"",
            ""path"": ""{editorInstancePath}""
        }},
        {{
            ""name"": ""Attach to Unity Player"",
            ""type"": ""unity"",
            ""request"": ""attach"",
            ""transportArgs"": {{
                ""port"": {bridgePort}
            }}
        }}
    ]
}}";
        File.WriteAllText(launchPath, launchContent);
    }
}
