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

android {
    namespace = "app.amizhthan.wolf"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.amizhthan.wolf"
        // Android 9: the first release where the Keystore can report StrongBox and where
        // cleartext traffic is refused by default.
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        resValue("string", "wolf_firebase_application_id", wolfSetting("wolf.firebase.applicationId"))
        resValue("string", "wolf_firebase_project_id", wolfSetting("wolf.firebase.projectId"))
        resValue("string", "wolf_firebase_api_key", wolfSetting("wolf.firebase.apiKey"))
        resValue("string", "wolf_firebase_sender_id", wolfSetting("wolf.firebase.senderId"))
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
