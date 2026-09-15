import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

/*
 * The Firebase project wake-ups arrive through, per deployment: from -P or local.properties, never committed.
 * These identify a project; they are not credentials — the sending credentials live only on the server. Without
 * all four the app is built with no push service, and tells its owner so.
 */
val localProperties = Properties().apply {
    rootProject.file("local.properties").takeIf { it.isFile }?.inputStream()?.use { stream -> load(stream) }
}

fun wolfSetting(name: String): String = (findProperty(name) as String?) ?: localProperties.getProperty(name) ?: ""

/*
 * Release signing, from the environment only. The release pipeline decodes the upload key from its secret store into a
 * temporary file and sets these; nothing about the key is committed, and nothing reads it from local.properties, where
 * it would sit beside the source. A release without all four refuses to package — see the check at the bottom — rather
 * than producing an unsigned or debug-signed APK that looks like a release.
 */
val releaseSigning: Map<String, String> =
    listOf("WOLF_ANDROID_KEYSTORE_FILE", "WOLF_ANDROID_KEYSTORE_PASSWORD", "WOLF_ANDROID_KEY_ALIAS", "WOLF_ANDROID_KEY_PASSWORD")
        .associateWith { System.getenv(it).orEmpty() }

/** A release's version, set by the release pipeline; any other build is 0.1.0 (1). */
val releaseVersionName: String = System.getenv("WOLF_ANDROID_VERSION_NAME").orEmpty().ifEmpty { "0.1.0" }
val releaseVersionCode: Int = System.getenv("WOLF_ANDROID_VERSION_CODE")?.toIntOrNull() ?: 1

android {
    namespace = "app.amizhthan.wolf"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.amizhthan.wolf"
        // Android 9: the first release where the Keystore can report StrongBox and where
        // cleartext traffic is refused by default.
        minSdk = 28
        targetSdk = 36
        versionCode = releaseVersionCode
        versionName = releaseVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        resValue("string", "wolf_firebase_application_id", wolfSetting("wolf.firebase.applicationId"))
        resValue("string", "wolf_firebase_project_id", wolfSetting("wolf.firebase.projectId"))
        resValue("string", "wolf_firebase_api_key", wolfSetting("wolf.firebase.apiKey"))
        resValue("string", "wolf_firebase_sender_id", wolfSetting("wolf.firebase.senderId"))
    }

    signingConfigs {
        create("release") {
            releaseSigning.getValue("WOLF_ANDROID_KEYSTORE_FILE").takeIf { it.isNotEmpty() }?.let { storeFile = file(it) }
            storePassword = releaseSigning.getValue("WOLF_ANDROID_KEYSTORE_PASSWORD")
            keyAlias = releaseSigning.getValue("WOLF_ANDROID_KEY_ALIAS")
            keyPassword = releaseSigning.getValue("WOLF_ANDROID_KEY_PASSWORD")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        compose = true
        // No BuildConfig: it is the only Java source this app would have, and compiling Java needs a
        // JDK image the build would otherwise have to produce with jlink. Per-build-type values live in
        // src/debug and src/release as Kotlin instead.
        buildConfig = false
        // Resources, not code: the Firebase project settings above, which need no Java source to exist.
        resValues = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isReturnDefaultValues = false
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp)
    implementation(libs.webrtc)
    implementation(libs.firebase.messaging)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlinx.coroutines.test)

    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.kotlinx.coroutines.test)
}

// Packaging or signing a release without its key stops here, naming everything the pipeline must provide. The Android
// Gradle plugin refuses as well, but names only the first missing property; and because this runs before the packaging
// task's own work, a refused build leaves the previous signed APK where it was.
val missingReleaseSigning: List<String> = releaseSigning.filterValues { it.isEmpty() }.keys.toList()
tasks.configureEach {
    if ((name == "packageRelease" || name == "signReleaseBundle") && missingReleaseSigning.isNotEmpty()) {
        doFirst {
            throw GradleException(
                "A release is never built unsigned: set ${missingReleaseSigning.joinToString(", ")} " +
                    "(the upload key, from the release pipeline's secrets). Debug builds and :app:minifyReleaseWithR8 need none of them.",
            )
        }
    }
}
