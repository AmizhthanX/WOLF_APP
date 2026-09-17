# kotlinx.serialization: keep generated serializers for the API models.
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class app.amizhthan.wolf.** {
    *** Companion;
}
-keepclasseswithmembers class app.amizhthan.wolf.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# libwebrtc is reached from native code by name.
-keep class org.webrtc.** { *; }
-keep class livekit.org.webrtc.** { *; }
# ...and so is jni_zero, the JNI glue libwebrtc registers in JNI_OnLoad. Without it R8 removed those classes and
# every release build aborted natively (SIGTRAP in JNI_OnLoad) the moment Start streaming loaded WebRTC — found on
# the owner's phone; debug builds are not shrunk, so no test had seen it.
-keep class org.jni_zero.** { *; }
-keep @org.jni_zero.CalledByNative class * { *; }
-keepclassmembers class * {
    @org.jni_zero.CalledByNative *;
    @org.jni_zero.CalledByNativeUnchecked *;
    @org.jni_zero.AccessedByNative *;
    native <methods>;
}
