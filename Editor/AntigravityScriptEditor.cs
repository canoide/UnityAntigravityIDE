using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Unity.CodeEditor;
using UnityEditor;
using UnityEngine;

[InitializeOnLoad]
public class AntigravityScriptEditor : IExternalCodeEditor
{
    const string EditorName = "Antigravity IDE";
    const string PrefKey_DebugPort = "Antigravity_DebugPort";
    const string PrefKey_ReuseWindow = "Antigravity_ReuseWindow";
    const string PrefKey_OpenWindowMode = "Antigravity_OpenWindowMode";
    const string PrefKey_GenerateLaunchJson = "Antigravity_GenerateLaunchJson";
    const string PrefKey_AnalyzerLevel = "Antigravity_AnalyzerLevel";
    const string PrefKey_Arguments = "Antigravity_Arguments";
    const string PrefKey_Extensions = "Antigravity_UserExtensions";
    const string PrefKey_ShowLogs = "Antigravity_ShowLogs";

    private static bool s_ShowLogs = false;

    public enum OpenWindowMode
    {
        Prompt = 0,       // Ask when Antigravity IDE is currently running
        ReuseWindow = 1,  // Always reuse active window (--reuse-window)
        NewWindow = 2     // Always open in a new window (--new-window)
    }

    private static OpenWindowMode? s_SessionWindowMode = null;

    public static OpenWindowMode WindowMode
    {
        get => s_SessionWindowMode ?? OpenWindowMode.Prompt;
        set => s_SessionWindowMode = value;
    }

    /// <summary>When true, informational [Antigravity] messages are printed to the Unity Console.</summary>
    public static bool ShowLogs
    {
        get => s_ShowLogs;
        set
        {
            s_ShowLogs = value;
            try
            {
                EditorPrefs.SetBool(PrefKey_ShowLogs, value);
            }
            catch
            {
                // In case called outside main thread
            }
        }
    }

    // ✅ LEARN: Proper filename-based detection like com.unity.ide.vscode
    // NOTE: All names here must be lowercase, with NO spaces or dashes.
    // Detection normalizes filenames by lowercasing and stripping spaces/dashes.
    static readonly string[] k_SupportedFileNames =
    {
        // Windows
        "antigravityide.exe",
        "antigravity-ide.exe",
        // macOS (.app bundles and inner binaries)
        "antigravityide.app",
        "antigravity-ide.app",
        "antigravityide",
        "antigravity-ide",
        // Linux
        "antigravityide",
        "antigravity-ide",
    };

    static readonly string DefaultArgument = "\"$(ProjectPath)\" -g \"$(File)\":$(Line):$(Column)";

    string m_Arguments;
    string Arguments
    {
        get => m_Arguments ?? (m_Arguments = EditorPrefs.GetString(PrefKey_Arguments, DefaultArgument));
        set
        {
            m_Arguments = value;
            EditorPrefs.SetString(PrefKey_Arguments, value);
        }
    }

    // ✅ LEARN: HandledExtensions from com.unity.ide.vscode
    static string[] DefaultExtensions
    {
        get
        {
            var customExtensions = new[] { "json", "asmdef", "asmref", "log", "shader", "compute", "hlsl", "cginc", "uss", "uxml" };
            return EditorSettings.projectGenerationBuiltinExtensions
                .Concat(EditorSettings.projectGenerationUserExtensions)
                .Concat(customExtensions)
                .Distinct().ToArray();
        }
    }

    static string HandledExtensionsString
    {
        get => EditorPrefs.GetString(PrefKey_Extensions, string.Join(";", DefaultExtensions));
        set => EditorPrefs.SetString(PrefKey_Extensions, value);
    }

    static string[] HandledExtensions => HandledExtensionsString
        .Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries)
        .Select(s => s.TrimStart('.', '*'))
        .ToArray();

    /// <summary>
    /// Normalizes a filename for comparison by lowercasing and stripping spaces and dashes.
    /// e.g. "Antigravity IDE.app" → "antigravityide.app", "antigravity-ide" → "antigravityide"
    /// </summary>
    private static string NormalizeFileName(string filename)
    {
        return filename.ToLower().Replace(" ", "").Replace("-", "");
    }

    private static string[] KnownPaths
    {
        get
        {
            var paths = new List<string>();

            if (Application.platform == RuntimePlatform.OSXEditor)
            {
                // System Applications - PRIORITIZE Antigravity-IDE
                paths.Add("/Applications/Antigravity-IDE.app");
                paths.Add("/Applications/Antigravity IDE.app");

                // User Applications - PRIORITIZE Antigravity-IDE
                var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                paths.Add(Path.Combine(userProfile, "Applications", "Antigravity-IDE.app"));
                paths.Add(Path.Combine(userProfile, "Applications", "Antigravity IDE.app"));

                // Homebrew / CLI - PRIORITIZE Antigravity-IDE
                paths.Add("/opt/homebrew/bin/antigravity-ide");
                paths.Add("/usr/local/bin/antigravity-ide");
            }
            else if (Application.platform == RuntimePlatform.WindowsEditor)
            {
                var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                paths.Add(Path.Combine(localAppData, "Programs", "Antigravity IDE", "Antigravity IDE.exe"));
                paths.Add(Path.Combine(localAppData, "Programs", "Antigravity IDE", "antigravity-ide.exe"));

                var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                paths.Add(Path.Combine(programFiles, "Antigravity IDE", "Antigravity IDE.exe"));
                paths.Add(Path.Combine(programFiles, "Antigravity IDE", "antigravity-ide.exe"));
            }
            else if (Application.platform == RuntimePlatform.LinuxEditor)
            {
                // PRIORITIZE Antigravity-IDE
                paths.Add("/opt/Antigravity/antigravity-ide");
                paths.Add("/usr/bin/antigravity-ide");
                paths.Add("/usr/local/bin/antigravity-ide");

                var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                paths.Add(Path.Combine(userProfile, ".local", "bin", "antigravity-ide"));
            }

            return paths.ToArray();
        }
    }

    static AntigravityScriptEditor()
    {
        try
        {
            s_ShowLogs = EditorPrefs.GetBool(PrefKey_ShowLogs, false);
        }
        catch
        {
            // Ignored if non-main thread
        }

        var editor = new AntigravityScriptEditor();
        CodeEditor.Register(editor);

        // Defer project file generation to avoid blocking domain reload / play mode entry.
        // Static constructors run during InitializeOnLoad and block the editor if they do heavy work.
        if (IsAntigravityInstallation(CodeEditor.CurrentEditorInstallation))
        {
            EditorApplication.delayCall += () => editor.CreateIfDoesntExist();
        }
    }

    // ✅ LEARN: CreateIfDoesntExist pattern from com.unity.ide.vscode
    public void CreateIfDoesntExist()
    {
        if (!File.Exists(GetSolutionPath()))
        {
            ProjectGeneration.Sync();
        }
    }

    private static string GetSolutionPath()
    {
        string projectName = Path.GetFileName(Directory.GetCurrentDirectory());
        return Path.Combine(Directory.GetCurrentDirectory(), $"{projectName}.sln");
    }

    public static bool IsSelectedEditor()
    {
        return IsAntigravityInstallation(CodeEditor.CurrentEditorInstallation);
    }

    private static bool IsAntigravityInstalled()
    {
        return KnownPaths.Any(p => File.Exists(p) || Directory.Exists(p));
    }

    private static bool IsAntigravityRunning()
    {
        try
        {
            var processes = Process.GetProcesses();
            foreach (var proc in processes)
            {
                try
                {
                    string processName = proc.ProcessName;
                    if (string.IsNullOrEmpty(processName)) continue;

                    string normalized = NormalizeFileName(processName);
                    if (normalized.Contains("antigravity"))
                    {
                        return true;
                    }
                }
                catch (Exception)
                {
                    // Ignore processes that cannot be accessed due to system permissions
                }
            }
        }
        catch (Exception e)
        {
            if (ShowLogs) UnityEngine.Debug.LogWarning($"[Antigravity] Failed to check running processes: {e.Message}");
        }
        return false;
    }

    // ✅ LEARN: Filename-based check like IsVSCodeInstallation
    private static bool IsAntigravityInstallation(string path)
    {
        if (string.IsNullOrEmpty(path)) return false;

        // Strictly avoid standalone agent/secondary background binaries
        if (path.IndexOf("agent", StringComparison.OrdinalIgnoreCase) >= 0 ||
            path.IndexOf("cli", StringComparison.OrdinalIgnoreCase) >= 0 ||
            path.IndexOf("helper", StringComparison.OrdinalIgnoreCase) >= 0 ||
            path.IndexOf("daemon", StringComparison.OrdinalIgnoreCase) >= 0 ||
            path.IndexOf("crashreporter", StringComparison.OrdinalIgnoreCase) >= 0 ||
            path.IndexOf("updater", StringComparison.OrdinalIgnoreCase) >= 0 ||
            path.IndexOf("notification", StringComparison.OrdinalIgnoreCase) >= 0 ||
            path.IndexOf("renderer", StringComparison.OrdinalIgnoreCase) >= 0 ||
            path.IndexOf("gpu", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            return false;
        }

        // Check filename directly
        var filename = Path.GetFileName(path);
        var normalized = NormalizeFileName(filename);
        if (k_SupportedFileNames.Contains(normalized))
            return true;

        // On macOS, the inner binary might be "Electron" inside "Antigravity IDE.app"
        // Check if any parent directory is an Antigravity IDE .app bundle
        if (path.IndexOf("Antigravity IDE", StringComparison.OrdinalIgnoreCase) >= 0 ||
            path.IndexOf("Antigravity-IDE", StringComparison.OrdinalIgnoreCase) >= 0)
            return true;

        return false;
    }

    private static string GetExecutablePath(string path)
    {
        // .app bundle resolution — macOS only
        if (Application.platform == RuntimePlatform.OSXEditor && path.EndsWith(".app"))
        {
            // Try the CLI binary first (reliable for --goto args)
            string cliBinary = Path.Combine(path, "Contents", "Resources", "app", "bin", "antigravity");
            if (File.Exists(cliBinary)) return cliBinary;

            // Fallback: inner binary in MacOS/
            string macosDir = Path.Combine(path, "Contents", "MacOS");
            if (Directory.Exists(macosDir))
            {
                string appName = Path.GetFileNameWithoutExtension(path);
                string executable = Path.Combine(macosDir, appName);
                if (File.Exists(executable)) return executable;

                foreach (var name in new[] { "Antigravity-IDE", "antigravity-ide", "Antigravity", "Antigravity IDE", "antigravity", "Electron" })
                {
                    executable = Path.Combine(macosDir, name);
                    if (File.Exists(executable)) return executable;
                }

                try
                {
                    var files = Directory.GetFiles(macosDir);
                    if (files.Length > 0) return files[0];
                }
                catch (Exception) { }
            }
            return path;
        }
        return path;
    }

    public CodeEditor.Installation[] Installations
    {
        get
        {
            var installations = new List<CodeEditor.Installation>();
            var seenPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var path in KnownPaths)
            {
                if (File.Exists(path) || Directory.Exists(path))
                {
                    // Prefer .app bundle paths on macOS — skip inner binaries if the .app is already listed
                    string canonicalPath = path;
                    if (!path.EndsWith(".app") && Application.platform == RuntimePlatform.OSXEditor)
                    {
                        int appIdx = path.IndexOf(".app/", StringComparison.OrdinalIgnoreCase);
                        if (appIdx >= 0)
                        {
                            canonicalPath = path.Substring(0, appIdx + 4);
                        }
                    }

                    if (seenPaths.Add(canonicalPath))
                    {
                        installations.Add(new CodeEditor.Installation
                        {
                            Name = EditorName,
                            Path = canonicalPath
                        });
                    }
                }
            }
            return installations.ToArray();
        }
    }

    public void Initialize(string editorInstallationPath)
    {
        // PERF: Don't call full Sync() on every domain reload — it spawns shell
        // processes and regenerates all project files, adding 500ms+ to Play mode entry.
        // Only generate if .sln is missing (first time or after clean).
        CreateIfDoesntExist();
    }

    public void OnGUI()
    {
        GUILayout.Label("Antigravity IDE Settings", EditorStyles.boldLabel);
        EditorGUILayout.Space(4);

        // Arguments
        Arguments = EditorGUILayout.TextField("External Script Editor Args", Arguments);
        if (GUILayout.Button("Reset argument", GUILayout.Width(120)))
        {
            Arguments = DefaultArgument;
        }

        EditorGUILayout.Space(4);

        // Open window mode preference
        string[] windowModeOptions = { "Prompt (Ask when running)", "Reuse Active Window", "Always Open New Window" };
        OpenWindowMode currentMode = WindowMode;
        OpenWindowMode newMode = (OpenWindowMode)EditorGUILayout.Popup(
            new GUIContent("Open Window Mode", "Configure whether opening a project reuses the active Antigravity window, opens a new window, or prompts when Antigravity is already running"),
            (int)currentMode, windowModeOptions);
        if (newMode != currentMode)
        {
            WindowMode = newMode;
        }

        EditorGUILayout.Space(2);

        // Show verbose logs preference
        bool showLogs = ShowLogs;
        bool newShowLogs = EditorGUILayout.Toggle(
            new GUIContent("Show Logs", "Print informational [Antigravity] messages to the Unity Console (errors and warnings are always shown)"),
            showLogs);
        if (newShowLogs != showLogs)
            ShowLogs = newShowLogs;

        EditorGUILayout.Space(2);

        // Debug port (automatically assigned)
        EditorGUILayout.LabelField(
            new GUIContent("Active Debug Port", "TCP port automatically assigned for Antigravity IDE connection"),
            new GUIContent(UnityDebugBridge.CurrentPort.ToString()));

        EditorGUILayout.Space(2);

        // Launch.json generation
        bool genLaunchJson = EditorPrefs.GetBool(PrefKey_GenerateLaunchJson, true);
        bool newGenLaunchJson = EditorGUILayout.Toggle(
            new GUIContent("Generate launch.json", "Auto-generate .vscode/launch.json for Unity debugging via DotRush"),
            genLaunchJson);
        if (newGenLaunchJson != genLaunchJson)
            EditorPrefs.SetBool(PrefKey_GenerateLaunchJson, newGenLaunchJson);

        EditorGUILayout.Space(2);

        // Analyzer level
        string[] analyzerOptions = { "None", "Default", "Recommended", "All" };
        int analyzerLevel = EditorPrefs.GetInt(PrefKey_AnalyzerLevel, 1);
        int newAnalyzerLevel = EditorGUILayout.Popup(
            new GUIContent("Analyzer Level", "Configure Roslyn analyzer severity level"),
            analyzerLevel, analyzerOptions);
        if (newAnalyzerLevel != analyzerLevel)
            EditorPrefs.SetInt(PrefKey_AnalyzerLevel, newAnalyzerLevel);

        EditorGUILayout.Space(4);

        // Generate .csproj flags (always enabled — we sync all packages)
        GUILayout.Label("Generate .csproj files for:", EditorStyles.label);
        EditorGUI.indentLevel++;
        EditorGUILayout.Toggle(new GUIContent("Embedded packages"), true);
        EditorGUILayout.Toggle(new GUIContent("Local packages"), true);
        EditorGUILayout.Toggle(new GUIContent("Registry packages"), true);
        EditorGUILayout.Toggle(new GUIContent("Git packages"), true);
        EditorGUILayout.Toggle(new GUIContent("Built-in packages"), true);
        EditorGUI.indentLevel--;

        EditorGUILayout.Space(4);

        // ✅ LEARN: HandledExtensions UI from com.unity.ide.vscode
        HandledExtensionsString = EditorGUILayout.TextField(
            new GUIContent("Extensions handled:"), HandledExtensionsString);

        EditorGUILayout.Space(8);

        // Action buttons
        EditorGUILayout.BeginHorizontal();
        if (GUILayout.Button("Regenerate Project Files", GUILayout.Height(24)))
        {
            ProjectGeneration.Sync(isManual: true);
        }

        if (GUILayout.Button("Reset Settings", GUILayout.Height(24)))
        {
            EditorPrefs.DeleteKey(PrefKey_DebugPort);
            EditorPrefs.DeleteKey(PrefKey_ReuseWindow);
            EditorPrefs.DeleteKey(PrefKey_OpenWindowMode);
            EditorPrefs.DeleteKey(PrefKey_GenerateLaunchJson);
            EditorPrefs.DeleteKey(PrefKey_AnalyzerLevel);
            EditorPrefs.DeleteKey(PrefKey_Arguments);
            EditorPrefs.DeleteKey(PrefKey_Extensions);
            EditorPrefs.DeleteKey(PrefKey_ShowLogs);
            s_ShowLogs = false;

            UnityEngine.Debug.Log("[Antigravity] Settings reset to defaults.");
        }
        EditorGUILayout.EndHorizontal();
    }


    public bool OpenProject(string filePath, int line, int column)
    {
        if (filePath != "" && (!SupportsExtension(filePath) || !File.Exists(filePath)))
        {
            return false;
        }

        if (line == -1) line = 1;
        if (column == -1) column = 0;

        string installation = CodeEditor.CurrentEditorInstallation;
        string projectDir = Directory.GetCurrentDirectory();

        if (string.IsNullOrEmpty(filePath))
            filePath = projectDir;

        try
        {
            var process = new Process();

            if (Application.platform == RuntimePlatform.OSXEditor && installation.EndsWith(".app"))
            {
                process.StartInfo.FileName = "/usr/bin/open";
                process.StartInfo.UseShellExecute = false;
                process.StartInfo.CreateNoWindow = true;

                if (Directory.Exists(filePath) && filePath == projectDir)
                {
                    process.StartInfo.Arguments = $"-a \"{installation}\" \"{projectDir}\"";
                }
                else
                {
                    string cliBinary = GetExecutablePath(installation);
                    if (File.Exists(cliBinary) && cliBinary != installation)
                    {
                        process.StartInfo.FileName = cliBinary;
                        process.StartInfo.Arguments = $"\"{projectDir}\" --goto \"{filePath}:{line}:{column}\"";
                    }
                    else
                    {
                        string uri = $"antigravity://file{filePath}:{line}:{column}";
                        process.StartInfo.Arguments = $"\"{uri}\"";
                    }
                }
            }
            else if (Application.platform == RuntimePlatform.OSXEditor)
            {
                // Direct binary path (e.g. Homebrew symlink)
                process.StartInfo.FileName = installation;

                var args = new List<string>();
                args.Add($"\"{projectDir}\"");

                if (!Directory.Exists(filePath) || filePath != projectDir)
                {
                    args.Add("--goto");
                    args.Add($"\"{filePath}:{line}:{column}\"");
                }

                process.StartInfo.Arguments = string.Join(" ", args);
                process.StartInfo.UseShellExecute = false;
                process.StartInfo.CreateNoWindow = true;
            }
            else
            {
                // Windows / Linux
                process.StartInfo.FileName = GetExecutablePath(installation);

                var args = new List<string>();
                args.Add($"\"{projectDir}\"");

                if (!Directory.Exists(filePath) || filePath != projectDir)
                {
                    args.Add("--goto");
                    args.Add($"\"{filePath}:{line}:{column}\"");
                }

                process.StartInfo.Arguments = string.Join(" ", args);
                process.StartInfo.WindowStyle = installation.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase)
                    ? ProcessWindowStyle.Hidden : ProcessWindowStyle.Normal;
                process.StartInfo.UseShellExecute = true;
                process.StartInfo.CreateNoWindow = true;
            }

            process.Start();
            return true;
        }
        catch (Exception e)
        {
            UnityEngine.Debug.LogError($"[Antigravity] Failed to open editor: {e.Message}");
            return false;
        }
    }

    // ✅ LEARN: SupportsExtension check from com.unity.ide.vscode
    static bool SupportsExtension(string path)
    {
        var extension = Path.GetExtension(path);
        if (string.IsNullOrEmpty(extension)) return false;
        return HandledExtensions.Contains(extension.TrimStart('.'));
    }

    public void SyncAll()
    {
        // ✅ LEARN: ResetPackageInfoCache before sync
        AssetDatabase.Refresh();
        ProjectGeneration.Sync();
    }

    public void SyncIfNeeded(string[] addedAssets, string[] deletedAssets, string[] movedAssets, string[] movedFromAssetPaths, string[] importedAssets)
    {
        ProjectGeneration.SyncIfNeeded(addedAssets, deletedAssets, movedAssets, movedFromAssetPaths, importedAssets);
    }

    public bool TryGetInstallationForPath(string editorPath, out CodeEditor.Installation installation)
    {
        if (string.IsNullOrEmpty(editorPath))
        {
            installation = default;
            return false;
        }

        // Strictly avoid standalone agent/secondary background binaries
        if (editorPath.IndexOf("agent", StringComparison.OrdinalIgnoreCase) >= 0 ||
            editorPath.IndexOf("cli", StringComparison.OrdinalIgnoreCase) >= 0 ||
            editorPath.IndexOf("helper", StringComparison.OrdinalIgnoreCase) >= 0 ||
            editorPath.IndexOf("daemon", StringComparison.OrdinalIgnoreCase) >= 0 ||
            editorPath.IndexOf("crashreporter", StringComparison.OrdinalIgnoreCase) >= 0 ||
            editorPath.IndexOf("updater", StringComparison.OrdinalIgnoreCase) >= 0 ||
            editorPath.IndexOf("notification", StringComparison.OrdinalIgnoreCase) >= 0 ||
            editorPath.IndexOf("renderer", StringComparison.OrdinalIgnoreCase) >= 0 ||
            editorPath.IndexOf("gpu", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            installation = default;
            return false;
        }

        var filename = Path.GetFileName(editorPath);
        var normalized = NormalizeFileName(filename);
        bool filenameMatch = k_SupportedFileNames.Contains(normalized);
        bool pathMatch = editorPath.IndexOf("antigravity", StringComparison.OrdinalIgnoreCase) >= 0;

        if (!filenameMatch && !pathMatch)
        {
            installation = default;
            return false;
        }

        // If the path points to an inner binary of a .app, use the .app path instead
        string installPath = editorPath;
        if (Application.platform == RuntimePlatform.OSXEditor)
        {
            int appIdx = editorPath.IndexOf(".app", StringComparison.OrdinalIgnoreCase);
            if (appIdx >= 0)
            {
                installPath = editorPath.Substring(0, appIdx + 4);
            }
        }

        installation = new CodeEditor.Installation
        {
            Name = EditorName,
            Path = installPath
        };
        return true;
    }
}
