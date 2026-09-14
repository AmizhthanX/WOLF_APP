# kotlinx.serialization: keep generated serializers for the API models.
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class app.amizhthan.wolf.** {
    *** Companion;
}
-keepclasseswithmembers class app.amizhthan.wolf.** {
    kotlinx.serialization.KSerializer serializer(...);
}
